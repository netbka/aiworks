// What fills workers' context (scripts/supervisor/worker-reading-cost.mjs): tool kinds, images counted as an estimate,
// re-reads, big reads and full diffs per role, the context weighting by later turns, repeated-run dollars, and the
// read-only measurement over a synthetic store and transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_CHARS, analyseTranscript, classify, measure, repeatCost, resultChars, summarise } from '../../scripts/supervisor/worker-reading-cost.mjs';
import { SQLITE } from './helpers.mjs';

const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

test('tool calls are classified by what they do', () => {
  assert.equal(classify('Bash', { command: 'node "C:/x/src/supervisor/gate.mjs" wait' }), 'tests');
  assert.equal(classify('Bash', { command: 'git diff main -- src/a.mjs' }), 'git');
  assert.equal(classify('Bash', { command: 'gh api repos/example/app/issues/1 --jq .body' }), 'gh');
  assert.equal(classify('Bash', { command: "sed -n '10,40p' src/a.mjs" }), 'shell-read');
  assert.equal(classify('Bash', { command: 'npm ci' }), 'shell-other');
  assert.equal(classify('mcp__browser__take_screenshot', {}), 'browser');
  assert.equal(classify('Read', { file_path: 'src/a.mjs' }), 'Read');
});

test('an image counts as its estimate, not its base64 length', () => {
  assert.equal(resultChars('abc'), 3);
  assert.equal(resultChars([{ type: 'text', text: 'abcd' }, { type: 'image', source: { data: 'x'.repeat(500_000) } }]), 4 + IMAGE_CHARS);
});

test('per role: whole-file re-reads, big whole-file reads and full diffs; ranged reads and diff --stat are not counted', () => {
  const big = 'y'.repeat(25_000);
  const { results, turns } = analyseTranscript([
    use('1', 'Read', { file_path: 'src/a.mjs' }), result('1', big),
    use('2', 'Bash', { command: 'cat src/a.mjs' }), result('2', big),
    use('3', 'Read', { file_path: 'src/a.mjs', offset: 10, limit: 20 }), result('3', 'z'.repeat(100)),
    use('4', 'Bash', { command: 'git diff --stat main' }), result('4', 's'.repeat(50)),
    use('5', 'Bash', { command: 'git diff main' }), result('5', 'd'.repeat(1_000)),
  ].map((entry) => JSON.stringify(entry)));
  assert.equal(turns, 5);
  const summary = summarise([{ role: 'verify', results, turns }]);
  const role = summary.roles.verify;
  assert.equal(role.chars, 2 * 25_000 + 100 + 50 + 1_000);
  assert.equal(role.rereads, 25_000, 'the second whole read of src/a.mjs');
  assert.equal(role.bigReads, 50_000, 'both whole reads over 20 KB; the ranged read is not one');
  assert.equal(role.fullDiffs, 1_000, 'git diff --stat is not a full diff');
  // A result read at turn 1 of 5 stays in context for 4 later turns; the last one counts once.
  assert.equal(summary.kinds.Read.weighted, 25_000 * 4 + 100 * 2);
});

test('repeated runs are a task\'s later implement and verify runs; a run with no reported cost is unknown, never zero', () => {
  const op = (task, kind, at, usd) => ({ campaign_id: 'c', task_id: task, kind, created_at: at, outcome: JSON.stringify({ receipt: usd === undefined ? {} : { costUsd: usd } }) });
  assert.deepEqual(repeatCost([op('A', 'implement', 1, 2), op('A', 'verify', 2, 1), op('A', 'implement', 3, 3), op('B', 'implement', 4, undefined)]),
    { first: 3, repeat: 3, unknownRuns: 1 });
});

test('measure reads a store and its transcripts read-only', { skip: !SQLITE && 'node:sqlite requires Node >= 22.5' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-reading-cost-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(root, 'supervisor.db'));
  db.exec('CREATE TABLE operations (campaign_id TEXT, task_id TEXT, kind TEXT, state TEXT, created_at INTEGER, outcome TEXT)');
  const now = Date.now();
  db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)').run('c', 'A', 'implement', 'finished', now - 1_000, JSON.stringify({ receipt: { sessionId: 's-1', costUsd: 1.5 } }));
  db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)').run('c', 'A', 'verify', 'finished', now - 500, JSON.stringify({ receipt: { sessionId: 's-2', costUsd: 0.5 } }));
  db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)').run('c', 'B', 'implement', 'dispatched', now - 100, null);
  db.close();
  const transcripts = join(root, 'projects');
  mkdirSync(join(transcripts, 'worktree-a'), { recursive: true });
  writeFileSync(join(transcripts, 'worktree-a', 's-1.jsonl'), [use('1', 'Read', { file_path: 'src/a.mjs' }), result('1', 'abc')].map((entry) => JSON.stringify(entry)).join('\n'));
  const report = await measure({ data: root, hours: 1, transcripts, now });
  assert.equal(report.operations, 2, 'finished operations only');
  assert.equal(report.transcriptsFound, 1);
  assert.equal(report.transcriptsMissing, 1);
  assert.equal(report.kinds.Read.chars, 3);
  assert.deepEqual(report.dollars, { first: 2, repeat: 0, unknownRuns: 0 });
});
