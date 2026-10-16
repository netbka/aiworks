// What fills AI workers' context, measured from their own session transcripts (read-only). Use it before and after a
// change meant to cut worker cost, the way `baseline` is used before a routing saving is claimed.
//
//   node scripts/supervisor/worker-reading-cost.mjs --data C:/example/aiworks/.local/supervisor [--hours 48]
//        [--transcripts <Claude projects directory>] [--json]
//
// It reads finished operations from the store (opened read-only), finds each worker session's transcript by its session
// id under the Claude CLI projects directory (default ~/.claude/projects), and reports:
// - by kind of tool result: calls, characters, share, and share weighted by the turns that re-read it from cache;
// - per role: whole-file re-reads, whole-file reads over 20 KB and full git diff or show output;
// - the share of reported dollars spent on repeated runs (each task's later implement and verify runs).
// Dollars are as the CLI reported them; a run with none counts as unknown, never zero. An image counts as an estimated
// 1,600 tokens (IMAGE_CHARS), not its base64 length. No network or GitHub call.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIG_READ = 20_000;
// An image in a tool result (a browser screenshot) costs the model about 1,600 tokens whatever its base64 length, so it
// counts as that many tokens at about four characters each. This is an estimate and the report says so.
export const IMAGE_CHARS = 6_400;

/** The characters a tool result adds to the context: text as written, each image as IMAGE_CHARS. */
export function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '').length;
  return content.reduce((sum, part) => sum + (part?.type === 'image' ? IMAGE_CHARS : part?.type === 'text' ? String(part.text ?? '').length : JSON.stringify(part ?? '').length), 0);
}

/** The kind of one tool call: tests, git, gh, shell-read, shell-other, browser, or the tool's own name. */
export function classify(name, input = {}) {
  if (/^mcp__browser__/.test(name)) return 'browser';
  if (name !== 'Bash' && name !== 'PowerShell') return name;
  const command = String(input.command ?? '');
  if (/gate\.mjs|npm (run )?(check|test)|node --test|run-tests\.mjs/.test(command)) return 'tests';
  if (/\bgh (api|issue|pr)\b/.test(command)) return 'gh';
  if (/\bgit (diff|log|show|status|grep|blame)\b/.test(command)) return 'git';
  if (/\b(grep|rg|sed -n|cat|head|tail|nl|wc|ls|find)\b/.test(command)) return 'shell-read';
  return 'shell-other';
}

const fileOf = (input = {}) => {
  if (input.file_path) return String(input.file_path).replaceAll('\\', '/');
  const match = String(input.command ?? '').match(/\b(?:cat|nl -ba)\s+(['"]?)([\w./\\:-]+\.\w+)\1/);
  return match ? match[2].replaceAll('\\', '/') : null;
};
const ranged = (input = {}) => input.offset !== undefined || input.limit !== undefined || /sed -n|\bhead\b|\btail\b/.test(String(input.command ?? ''));
const fullDiff = (command) => /\bgit (diff|show)\b/.test(command) && !/--stat|--shortstat|--name-only|--name-status/.test(command);

/** One transcript (its JSON lines) as tool results: `{ kind, chars, turn, file, ranged, diff }`, and its turn count. */
export function analyseTranscript(lines) {
  const uses = new Map();
  const results = [];
  let turn = 0;
  for (const line of lines) {
    let entry;
    try { entry = typeof line === 'string' ? JSON.parse(line) : line; } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    if (entry.type === 'assistant') {
      turn++;
      for (const block of content) if (block.type === 'tool_use') uses.set(block.id, { kind: classify(block.name, block.input), file: fileOf(block.input), ranged: ranged(block.input), diff: fullDiff(String(block.input?.command ?? '')) });
    }
    if (entry.type === 'user') for (const block of content) if (block.type === 'tool_result') {
      const use = uses.get(block.tool_use_id) ?? { kind: 'unknown', file: null, ranged: false, diff: false };
      results.push({ ...use, chars: resultChars(block.content), turn });
    }
  }
  return { results, turns: turn };
}

/** Totals over analysed sessions: `sessions` is `[{ role, results, turns }]`. */
export function summarise(sessions) {
  const kinds = {};
  const roles = {};
  let chars = 0, weighted = 0;
  for (const { role, results, turns } of sessions) {
    const r = (roles[role] ??= { sessions: 0, chars: 0, rereads: 0, bigReads: 0, fullDiffs: 0 });
    r.sessions++;
    const seen = new Set();
    for (const result of results) {
      const weight = result.chars * Math.max(1, turns - result.turn);
      const k = (kinds[result.kind] ??= { calls: 0, chars: 0, weighted: 0 });
      k.calls++; k.chars += result.chars; k.weighted += weight;
      chars += result.chars; weighted += weight; r.chars += result.chars;
      if (result.diff) r.fullDiffs += result.chars;
      if (result.file && !result.ranged) {
        if (seen.has(result.file)) r.rereads += result.chars;
        if (result.chars > BIG_READ) r.bigReads += result.chars;
        seen.add(result.file);
      }
    }
  }
  return { chars, weighted, kinds, roles };
}

/** Reported dollars of first runs and of repeated runs (a task's second and later implement or verify run). */
export function repeatCost(operations) {
  const seen = new Set();
  const cost = { first: 0, repeat: 0, unknownRuns: 0 };
  for (const op of [...operations].sort((a, b) => a.created_at - b.created_at)) {
    const key = `${op.campaign_id}/${op.task_id}/${op.kind}`;
    const usd = JSON.parse(op.outcome || '{}').receipt?.costUsd;
    if (typeof usd !== 'number') cost.unknownRuns++;
    else if (seen.has(key)) cost.repeat += usd;
    else cost.first += usd;
    seen.add(key);
  }
  return cost;
}

function transcriptFinder(directory) {
  const projects = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(directory, entry.name)) : [];
  return (sessionId) => projects.map((project) => join(project, `${sessionId}.jsonl`)).find((file) => existsSync(file)) ?? null;
}

export async function measure({ data, hours = 48, transcripts = join(homedir(), '.claude', 'projects'), now = Date.now() }) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(data, 'supervisor.db'), { readOnly: true });
  const operations = db.prepare("SELECT campaign_id, task_id, kind, created_at, outcome FROM operations WHERE state = 'finished' AND created_at > ?").all(now - hours * 3_600_000);
  db.close();
  const find = transcriptFinder(transcripts);
  const sessions = [];
  let missing = 0;
  for (const op of operations) {
    const sessionId = JSON.parse(op.outcome || '{}').receipt?.sessionId;
    const file = sessionId && find(sessionId);
    if (!file) { missing++; continue; }
    sessions.push({ role: op.kind, ...analyseTranscript(readFileSync(file, 'utf8').split('\n').filter(Boolean)) });
  }
  return { hours, operations: operations.length, transcriptsFound: sessions.length, transcriptsMissing: missing, ...summarise(sessions), dollars: repeatCost(operations) };
}

const pct = (part, whole) => (whole ? `${(100 * part / whole).toFixed(1)}%` : '-');

function print(report) {
  console.log(`${report.operations} finished operations in ${report.hours} h; transcripts found ${report.transcriptsFound}, missing ${report.transcriptsMissing}`);
  console.log(`${'kind'.padEnd(13)}${'calls'.padStart(7)}${'chars'.padStart(12)}${'share'.padStart(8)}${'weighted'.padStart(10)}`);
  for (const [kind, k] of Object.entries(report.kinds).sort((a, b) => b[1].weighted - a[1].weighted)) {
    console.log(`${kind.padEnd(13)}${String(k.calls).padStart(7)}${String(k.chars).padStart(12)}${pct(k.chars, report.chars).padStart(8)}${pct(k.weighted, report.weighted).padStart(10)}`);
  }
  for (const [role, r] of Object.entries(report.roles)) {
    console.log(`${role}: ${r.sessions} sessions; whole-file re-reads ${pct(r.rereads, r.chars)}, whole-file reads over 20 KB ${pct(r.bigReads, r.chars)}, full diffs ${pct(r.fullDiffs, r.chars)}`);
  }
  const { first, repeat, unknownRuns } = report.dollars;
  console.log(`reported dollars: $${(first + repeat).toFixed(2)}, of which repeated runs $${repeat.toFixed(2)} (${pct(repeat, first + repeat)}); runs with no reported cost: ${unknownRuns}`);
}

async function main(argv) {
  const options = {};
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--data') options.data = argv[++index];
    else if (argv[index] === '--hours') options.hours = Number(argv[++index]);
    else if (argv[index] === '--transcripts') options.transcripts = argv[++index];
    else if (argv[index] === '--json') json = true;
    else { console.error(`unknown argument ${argv[index]}`); return 2; }
  }
  if (!options.data || (options.hours !== undefined && !(options.hours > 0))) {
    console.error('usage: worker-reading-cost.mjs --data <supervisor data directory> [--hours 48] [--transcripts <dir>] [--json]');
    return 2;
  }
  const report = await measure(options);
  if (json) console.log(JSON.stringify(report, null, 2));
  else print(report);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
