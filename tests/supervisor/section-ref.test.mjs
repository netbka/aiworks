// Section references for declarations (scripts/supervisor/section-ref.mjs): list a document's sections with their lines,
// accept an exact slug, refuse a prefix, a missing heading or an invalid reference with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sectionReference, sectionTable } from '../../scripts/supervisor/section-ref.mjs';

const DOC = ['# Runbook', '', '## 1. Boundary', 'text', '', '### Merge gate', 'more', '', '## 2. State and ownership', 'last', ''].join('\n');

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-section-ref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'RUNBOOK.md'), DOC);
  return root;
}

test('lists every section of a document with its reference and lines', (t) => {
  const rows = sectionTable('docs/RUNBOOK.md', { repo: repo(t) });
  assert.deepEqual(rows.map((row) => [row.reference, row.from, row.to]), [
    ['docs/RUNBOOK.md#runbook', 1, 10],
    ['docs/RUNBOOK.md#1-boundary', 3, 8],
    ['docs/RUNBOOK.md#merge-gate', 6, 8],
    ['docs/RUNBOOK.md#2-state-and-ownership', 9, 10],
  ]);
});

test('accepts an exact slug and refuses a prefix, a missing heading and an invalid reference, saying why', (t) => {
  const root = repo(t);
  assert.equal(sectionReference('docs/RUNBOOK.md', '1-boundary', { repo: root }), 'docs/RUNBOOK.md#1-boundary');
  assert.throws(() => sectionReference('docs/RUNBOOK.md', 'merge', { repo: root }), /the exact slug is merge-gate/);
  assert.throws(() => sectionReference('docs/RUNBOOK.md', '3-lifecycle', { repo: root }), /missing/);
  assert.throws(() => sectionReference('docs/RUNBOOK.md', 'Bad Slug', { repo: root }), /not a valid reference/);
});
