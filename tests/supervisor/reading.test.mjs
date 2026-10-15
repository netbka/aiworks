// Scoped reading, slice READ1 (docs/design/SCOPED_READING.md sections 3, 4 and 13): the reference grammar, the GitHub
// heading slug, the heading table and section resolution. Pure functions over strings and this checkout's own documents;
// no worker, model, network or GitHub call.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { test } from 'node:test';
import { extent, headings, MAX_DOCUMENT_BYTES, parseReference, resolveSection, slugify } from '../../src/supervisor/reading.mjs';
import { ROOT } from './helpers.mjs';

test('a reference is a path, or a path and one anchor of [a-z0-9_-]', () => {
  assert.deepEqual(parseReference('AGENTS.md'), { path: 'AGENTS.md', anchor: null });
  assert.deepEqual(parseReference('docs/SUPERVISOR.md#3-lifecycle-of-one-task'), { path: 'docs/SUPERVISOR.md', anchor: '3-lifecycle-of-one-task' });
  assert.deepEqual(parseReference('docs/A.md#snake_case-1'), { path: 'docs/A.md', anchor: 'snake_case-1' });
  assert.deepEqual(parseReference(`docs/A.md#${'a'.repeat(160)}`), { path: 'docs/A.md', anchor: 'a'.repeat(160) });
  for (const bad of ['docs/A.md#x#y', 'docs/A.md#', '#x', 'docs/A.md#Upper', 'docs/A.md#a b', 'docs/A.md#a.b', 'docs/A.md#%41',
    `docs/A.md#${'a'.repeat(161)}`, '/etc/passwd#x', '../A.md#x', 'docs/../A.md#x', 'docs//A.md#x', 'docs\\A.md#x', 'C:/A.md#x', '', ' ',
    null, 7, ['AGENTS.md']]) {
    assert.equal(parseReference(bad), null, JSON.stringify(bad));
  }
});

test('slugify follows the GitHub algorithm: lower case, punctuation dropped, each space a hyphen', () => {
  assert.equal(slugify('3. Lifecycle of one task'), '3-lifecycle-of-one-task');
  assert.equal(slugify('6. Build order, lanes and file ownership'), '6-build-order-lanes-and-file-ownership');
  assert.equal(slugify('AW-009 - Public commits contain no installation data'), 'aw-009---public-commits-contain-no-installation-data');
  assert.equal(slugify('5.5 Separate Auto Release mode (owner approved D5; tracked #13)'), '55-separate-auto-release-mode-owner-approved-d5-tracked-13');
  assert.equal(slugify('3.1 Durable operation schema (`store.mjs`)'), '31-durable-operation-schema-storemjs');
  assert.equal(slugify('5.3 Role/model/cost routing'), '53-rolemodelcost-routing');
  assert.equal(slugify('Rate limits & quotas'), 'rate-limits--quotas');
  assert.equal(slugify('snake_case stays'), 'snake_case-stays');
  assert.equal(slugify('See [the runbook](docs/SUPERVISOR.md) <em>now</em>'), 'see-the-runbook-now');
  assert.equal(slugify('  Trailing spaces  '), 'trailing-spaces');
});

test('headings: ATX levels 1 to 6, fenced code blocks ignored, duplicates numbered -1 and -2', () => {
  const doc = [
    '# Title',             // 1
    'Intro',               // 2
    '## Setup ##',         // 3
    '```sh',               // 4
    '# not a heading',     // 5
    '````',                // 6 (closes: same character, at least as long)
    '## Setup',            // 7
    '~~~',                 // 8
    '## inside tilde fence', // 9
    '```',                 // 10 (does not close a tilde fence)
    '~~~',                 // 11
    '   ### Indented three',  // 12
    '    #### Indented four is code', // 13
    '####### seven is text', // 14
    '#hashtag is text',    // 15
    '## Setup',            // 16
    '###### Six',          // 17
    'Setext is not recognised', // 18
    '===',                 // 19
  ].join('\n');
  assert.deepEqual(headings(doc), [
    { level: 1, text: 'Title', slug: 'title', line: 1 },
    { level: 2, text: 'Setup', slug: 'setup', line: 3 },
    { level: 2, text: 'Setup', slug: 'setup-1', line: 7 },
    { level: 3, text: 'Indented three', slug: 'indented-three', line: 12 },
    { level: 2, text: 'Setup', slug: 'setup-2', line: 16 },
    { level: 6, text: 'Six', slug: 'six', line: 17 },
  ]);
  // A numbered duplicate never takes a slug a later heading already uses on its own.
  assert.deepEqual(headings('# A\n# A-1\n# A\n# A').map((heading) => heading.slug), ['a', 'a-1', 'a-2', 'a-3']);
  assert.deepEqual(headings('# A\n# A\n# A-1').map((heading) => heading.slug), ['a', 'a-1', 'a-1-1']);
  assert.deepEqual(headings('# Windows\r\n\r\n## Line endings\r\n').map((heading) => [heading.slug, heading.line]), [['windows', 1], ['line-endings', 3]]);
  assert.deepEqual(headings('```\n# never closed\n'), []);
});

const DOC = [
  '# Runbook',                        // 1
  '',                                 // 2
  '## 1. Boundary',                   // 3
  'text',                             // 4
  '### 1.1 Inside',                   // 5
  'more',                             // 6
  '## 2. Lifecycle of one task',      // 7
  '#### 2.0.1 Deep',                  // 8
  '### 2.1 Child tasks inside the envelope', // 9
  'x',                                // 10
  '## 3. Liveness',                   // 11
  '### 3.1 Child audit',              // 12
  'end',                              // 13
  '',                                 // 14 (the final line break ends line 13; this line is not counted)
].join('\n');

test('resolveSection: exact slug, unique prefix, ambiguous prefix and missing anchors', () => {
  assert.deepEqual(resolveSection(DOC, '1-boundary'), { resolved: true, heading: '1. Boundary', level: 2, slug: '1-boundary', from: 3, to: 6 });
  assert.deepEqual(resolveSection(DOC, '21-child'), { resolved: true, heading: '2.1 Child tasks inside the envelope', level: 3,
    slug: '21-child-tasks-inside-the-envelope', from: 9, to: 10 }, 'exactly one slug starts with the anchor and a hyphen');
  assert.deepEqual(resolveSection(DOC, '2'), { resolved: true, heading: '2. Lifecycle of one task', level: 2, slug: '2-lifecycle-of-one-task', from: 7, to: 10 });
  assert.deepEqual(resolveSection('# a\n## a-b\n## a-c\n', 'a-b'), { resolved: true, heading: 'a-b', level: 2, slug: 'a-b', from: 2, to: 2 });
  assert.deepEqual(resolveSection('# x\n## Setup\n## Setup more\n', 'setup'), { resolved: true, heading: 'Setup', level: 2, slug: 'setup', from: 2, to: 2 },
    'an exact match wins over a prefix');
  assert.deepEqual(resolveSection('# x\n## Setup one\n## Setup two\n', 'setup'), { resolved: false, reason: 'ambiguous' });
  assert.deepEqual(resolveSection(DOC, '1-bound'), { resolved: false, reason: 'missing' }, 'a prefix must end at a hyphen');
  assert.deepEqual(resolveSection(DOC, '9-nowhere'), { resolved: false, reason: 'missing' });
  assert.deepEqual(resolveSection('```\n# Hidden\n```\n', 'hidden'), { resolved: false, reason: 'missing' }, 'a fenced heading is not a section');
  assert.deepEqual(resolveSection('# A\n# A\nx\n', 'a-1'), { resolved: true, heading: 'A', level: 1, slug: 'a-1', from: 2, to: 3 });
});

test('extent: up to the next heading of the same or a higher level, or to the end of the file', () => {
  const table = headings(DOC);
  const at = (slug) => table.findIndex((heading) => heading.slug === slug);
  assert.deepEqual(extent(table, at('1-boundary'), 13), { from: 3, to: 6 }, 'the next heading at the same level ends it');
  assert.deepEqual(extent(table, at('11-inside'), 13), { from: 5, to: 6 }, 'a higher-level heading ends it');
  assert.deepEqual(extent(table, at('201-deep'), 13), { from: 8, to: 8 }, 'a higher level, even one skipped in between, ends it');
  assert.deepEqual(extent(table, at('31-child-audit'), 13), { from: 12, to: 13 }, 'the last section runs to the end of the file');
  assert.deepEqual(extent(table, at('runbook'), 13), { from: 1, to: 13 }, 'a top-level heading spans the document');
  assert.deepEqual(resolveSection(DOC, '3-liveness'), { resolved: true, heading: '3. Liveness', level: 2, slug: '3-liveness', from: 11, to: 13 });
  assert.deepEqual(resolveSection(DOC.replace(/\n$/, ''), '3-liveness').to, 13, 'with or without a final line break');
  assert.deepEqual(resolveSection(DOC.replace(/\n/g, '\r\n'), '3-liveness').to, 13, 'CRLF line endings count the same lines');
});

test('resolveSection: non-Markdown, over 2 MiB, binary and unreadable input widen to the whole document', () => {
  const big = `# Big\n${'x'.repeat(MAX_DOCUMENT_BYTES)}\n`;
  assert.equal(MAX_DOCUMENT_BYTES, 2 * 1024 * 1024);
  assert.deepEqual(resolveSection(big, 'big'), { resolved: false, reason: 'not-markdown' });
  assert.deepEqual(resolveSection(Buffer.from(big), 'big'), { resolved: false, reason: 'not-markdown' });
  // Bytes, not characters, count toward the limit: one multi-byte character over it is too large.
  const edge = `# Edge\n${'x'.repeat(MAX_DOCUMENT_BYTES - 8)}`;
  assert.equal(Buffer.byteLength(edge), MAX_DOCUMENT_BYTES - 1);
  assert.equal(resolveSection(edge, 'edge').resolved, true, 'just under the limit resolves');
  assert.deepEqual(resolveSection(`${edge}é`, 'edge'), { resolved: false, reason: 'not-markdown' });
  assert.deepEqual(resolveSection('# Title\n', 'title', 'schemas/packet.json'), { resolved: false, reason: 'not-markdown' });
  assert.deepEqual(resolveSection('# Title\n', 'title', 'docs/README'), { resolved: false, reason: 'not-markdown' });
  assert.deepEqual(resolveSection('# Title\n\u0000\n', 'title', 'docs/A.md'), { resolved: false, reason: 'not-markdown' }, 'a NUL byte is binary');
  assert.deepEqual(resolveSection(Buffer.from([0x23, 0x20, 0x41, 0x00]), 'a'), { resolved: false, reason: 'not-markdown' });
  assert.equal(resolveSection('# Title\n', 'title', 'docs/A.md').resolved, true);
  assert.equal(resolveSection('# Title\n', 'title', 'docs/A.MARKDOWN').resolved, true);
  assert.equal(resolveSection(Buffer.from('# Title\n'), 'title', 'docs/A.md').resolved, true);
  for (const content of [null, undefined, 42]) assert.deepEqual(resolveSection(content, 'title'), { resolved: false, reason: 'unreadable' });
});

// Every Markdown link `[text](target.md#anchor)` or `[text](#anchor)` in this checkout's documents, resolved to a file.
const markdownFiles = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  const path = dir ? `${dir}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return ['node_modules', '.git', 'campaigns', '.local'].includes(entry.name) ? [] : markdownFiles(path);
  return entry.name.endsWith('.md') ? [path] : [];
});
const anchoredLinks = (file) => [...readFileSync(join(ROOT, file), 'utf8').matchAll(/\]\(([^)\s]*?)#([^)\s]+)\)/g)]
  .filter(([, target]) => !/^[a-z]+:/i.test(target) && (target === '' || target.endsWith('.md')))
  .map(([link, target, anchor]) => ({ link, anchor, from: file, to: target ? posix.normalize(posix.join(dirname(file).replace(/\\/g, '/'), target)) : file }));

test('the slug of every design document heading matches the anchors that documents link to', () => {
  const design = readdirSync(join(ROOT, 'docs/design')).filter((name) => name.endsWith('.md')).map((name) => `docs/design/${name}`);
  assert.ok(design.length >= 6, 'the design documents are present');
  const links = markdownFiles('').flatMap(anchoredLinks);
  const intoDesign = links.filter((link) => design.includes(link.to));
  const fromDesign = links.filter((link) => design.includes(link.from));
  assert.ok(intoDesign.length >= 10 && fromDesign.length >= 50, `links found: ${intoDesign.length} into, ${fromDesign.length} from the design documents`);
  // Every anchor a design document is linked by, and every anchor a design document links to, is a heading slug there.
  for (const { link, anchor, from, to } of [...intoDesign, ...fromDesign]) {
    const slugs = headings(readFileSync(join(ROOT, to), 'utf8')).map((heading) => heading.slug);
    assert.ok(slugs.includes(anchor), `${from}: ${link} names no heading of ${to}`);
    assert.equal(resolveSection(readFileSync(join(ROOT, to), 'utf8'), anchor, to).resolved, true, `${from}: ${link}`);
    assert.ok(parseReference(`${to}#${anchor}`), `${to}#${anchor} is a valid reference`);
  }
  // The examples this design gives resolve in this checkout.
  const supervisor = readFileSync(join(ROOT, 'docs/SUPERVISOR.md'), 'utf8');
  assert.equal(resolveSection(supervisor, '1-boundary', 'docs/SUPERVISOR.md').resolved, true);
  assert.equal(resolveSection(supervisor, '3-lifecycle-of-one-task', 'docs/SUPERVISOR.md').resolved, true);
});
