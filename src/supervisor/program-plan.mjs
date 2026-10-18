// AIWorks program waves (docs/PROJECT_WORKSPACE_PLAN.md section 6.8d, slice PROG2; netbka/aiworks#153 option B): the
// next wave proposed from the plan by fixed rules, never by a model. This module is pure: it parses the plan's slice
// rows, turn order and shared-file table from text the caller supplies, decides which slices are ready from task facts
// the caller supplies, and builds one version 1 declaration. It reads no file, store, git or network, and registers
// nothing: registration is PROG3, and the whole lane stays off until PROG5.
import { authorityDigest, validateDeclaration } from './campaign.mjs';
import { headings } from './reading.mjs';

const ROW_HEADER = ['ID', 'Outcome', 'Owns', 'Depends on', 'Tests', 'Owner decision'];
const SHARED_HEADER = ['Shared file', 'Writers, in order'];
// A slice or task ID as the plan writes it: RUN1, RUN1B, REL5a, R2-KEEPER, MERGE-GATE. A word without a digit or a
// hyphen ("UI", "SCH") is prose, not an ID.
const ID_TOKEN = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*[a-z]?\b/g;
const isId = (token) => /[0-9-]/.test(token);
const RANGE = /^([A-Z]+)(\d+)-\1(\d+)$/;
const PATH = /^[A-Za-z0-9._/-]+$/;
const MAX_GOAL = 1500;
const MAX_OUTCOME = 300;
const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const MAX_TASKS = 32;
const MAX_WRITES = 32;

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
const plain = (text) => text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
// Parenthesised remarks ("(new)", "(api turn)", "(`release` field)") are notes, not files or dependencies.
const withoutRemarks = (text) => {
  let out = text;
  for (let before = ''; before !== out;) { before = out; out = out.replace(/\([^()]*\)/g, ' '); }
  return out;
};
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`);
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);
const firstSentence = (text) => /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
const folded = (path) => path.toLowerCase();
// A write entry covers another when they are equal or the first is a directory (trailing slash) holding the second.
const covers = (a, b) => folded(a) === folded(b) || (a.endsWith('/') && folded(b).startsWith(folded(a)));
const overlaps = (a, b) => covers(a, b) || covers(b, a);

function ids(text) {
  const out = [];
  for (const token of withoutRemarks(text).match(ID_TOKEN) ?? []) {
    const range = RANGE.exec(token);
    if (range) for (let n = Number(range[2]); n <= Number(range[3]); n += 1) out.push(`${range[1]}${n}`);
    else if (isId(token)) out.push(token);
  }
  return [...new Set(out)];
}

/** The path abbreviations of section 6.2's "Paths:" line: `sup/` is `src/supervisor/`, "SUPERVISOR.md" is `docs/SUPERVISOR.md`. */
function abbreviations(lines) {
  const line = lines.find((text) => /^Paths:/.test(text.trim()));
  if (!line) throw new TypeError('plan section 6 has no "Paths:" line');
  const map = {};
  for (const match of line.matchAll(/(?:`([^`]+)`|"([^"]+)") is `([^`]+)`/g)) map[match[1] ?? match[2]] = match[3];
  if (!Object.keys(map).length) throw new TypeError('plan "Paths:" line names no abbreviation');
  return map;
}

function expand(token, short) {
  let path = token.trim();
  if (Object.hasOwn(short, path)) path = short[path];
  else {
    const prefix = Object.keys(short).filter((key) => key.endsWith('/') && path.startsWith(key)).sort((a, b) => b.length - a.length)[0];
    if (prefix) path = short[prefix] + path.slice(prefix.length);
  }
  if (path.endsWith('/*')) path = path.slice(0, -1);
  const valid = PATH.test(path) && /[/.]/.test(path) && !path.startsWith('/') &&
    !path.replace(/\/$/, '').split('/').some((part) => !part || part === '.' || part === '..');
  return valid ? path : null;
}

/** The repository files an *Owns* cell names: backticked paths and bare abbreviations, remarks in parentheses left out. */
function ownedFiles(owns, short) {
  const text = withoutRemarks(owns);
  const tokens = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const bare = text.replace(/`[^`]*`/g, ' ');
  for (const key of Object.keys(short).filter((name) => !name.endsWith('/'))) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^\\w./-])${escaped}(?![\\w/-])`).test(bare)) tokens.push(key);
  }
  const files = [];
  for (const token of tokens) {
    const path = expand(token, short);
    if (path && !files.some((file) => folded(file) === folded(path))) files.push(path);
  }
  return files;
}

/**
 * The plan's section 6 as data: `{ abbreviations, slices, turnOrder, sharedFiles }`. A slice is one row of a table with the
 * columns ID, Outcome, Owns, Depends on, Tests, Owner decision; it keeps its heading and that heading's GitHub anchor.
 * Throws a TypeError when section 6, its "Paths:" line, the turn order or the shared-file table is missing, or a row is
 * malformed or repeats an ID.
 */
export function parsePlan(text) {
  if (typeof text !== 'string') throw new TypeError('plan text must be a string');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## 6\.\s/.test(line));
  if (start < 0) throw new TypeError('plan has no section 6');
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  if (end < 0) end = lines.length;
  const anchors = new Map(headings(text).map((heading) => [heading.line, heading]));
  const short = abbreviations(lines.slice(start, end));

  const slices = [];
  const sharedFiles = [];
  let turnOrder = null;
  let section = { title: plain(lines[start].replace(/^#+\s*/, '')), anchor: anchors.get(start + 1)?.slug ?? null };
  let table = null;
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    const heading = /^#{2,6}\s+(.*)$/.exec(line);
    if (heading) section = { title: plain(heading[1]), anchor: anchors.get(index + 1)?.slug ?? null };
    if (/^\*\*Turn order:\*\*/.test(line.trim())) {
      if (turnOrder) throw new TypeError(`plan line ${index + 1}: a second turn order`);
      turnOrder = line.trim().replace(/^\*\*Turn order:\*\*/, '').replace(/\.\s*$/, '').split('→').map((id) => id.trim());
      if (turnOrder.length < 2 || !turnOrder.every((id) => /^[A-Z][A-Za-z0-9-]*$/.test(id) && isId(id))) {
        throw new TypeError(`plan line ${index + 1}: the turn order must be IDs separated by →`);
      }
    }
    if (!line.trim().startsWith('|')) { table = null; continue; }
    const row = cells(line);
    if (row.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (table === null) {
      table = row.join('|') === ROW_HEADER.join('|') ? 'slices' : row.join('|') === SHARED_HEADER.join('|') ? 'shared' : 'other';
      continue;
    }
    if (table === 'slices') {
      if (row.length !== ROW_HEADER.length) throw new TypeError(`plan line ${index + 1}: a slice row needs ${ROW_HEADER.length} cells`);
      const id = /^\*\*([A-Za-z0-9-]+)\*\*$/.exec(row[0])?.[1];
      if (!id) throw new TypeError(`plan line ${index + 1}: a slice row starts with its **ID**`);
      if (slices.some((slice) => slice.id === id)) throw new TypeError(`plan line ${index + 1}: slice ${id} is listed twice`);
      const [outcome, owns, dependsOn, tests, ownerDecision] = row.slice(1).map(plain);
      slices.push({
        id, section: section.title, anchor: section.anchor, line: index + 1, outcome, owns, dependsOn, tests, ownerDecision,
        files: /^In `[^`]+`:/.test(owns) ? [] : ownedFiles(owns, short),
        dependencies: ids(dependsOn).filter((dep) => dep !== id),
        runbookOnly: /\bRunbook only\b/i.test(outcome),
        // "In `example-org/governance`: ..." names files of another repository.
        otherRepository: /^In `[^`]+`:/.test(owns),
      });
    }
    if (table === 'shared') {
      if (row.length !== SHARED_HEADER.length) throw new TypeError(`plan line ${index + 1}: a shared-file row needs ${SHARED_HEADER.length} cells`);
      const files = [...row[0].matchAll(/`([^`]+)`/g)].map((match) => expand(match[1], short));
      if (!files.length || files.includes(null)) throw new TypeError(`plan line ${index + 1}: a shared-file row names its files in backticks`);
      sharedFiles.push({ files, writers: ids(row[1]) });
    }
  }
  if (!slices.length) throw new TypeError('plan section 6 has no slice rows');
  if (!turnOrder) throw new TypeError('plan section 6 has no "**Turn order:**" line');
  if (!sharedFiles.length) throw new TypeError('plan section 6 has no shared-file table');
  return { abbreviations: short, slices, turnOrder, sharedFiles };
}

/**
 * Whether a program record's `allow` or `exclude` entry covers a slice: the slice ID itself, or its lane prefix (PROG covers PROG2).
 * Only an entry with no digit is a lane: a slice ID covers itself alone, so UI1 never covers UI10 and REL1 never covers REL11.
 */
export const coversSlice = (entry, id) => entry === id
  || (!/\d/.test(entry) && id.startsWith(entry) && /^\d/.test(id.slice(entry.length)));

/**
 * Task facts folded per ID: `[{ taskId, state, onMain }]`, where `state` is the task's state in this repository and
 * `onMain` is true once its verified commit is on the base branch. Done or running anywhere wins.
 */
function factsById(facts) {
  if (!Array.isArray(facts)) throw new TypeError('task facts must be an array');
  const byId = new Map();
  for (const fact of facts) {
    if (!fact || typeof fact.taskId !== 'string') throw new TypeError('each task fact needs a taskId');
    const seen = byId.get(fact.taskId) ?? { done: false, running: false, merged: false };
    if (fact.state === 'done') seen.done = true;
    if (fact.state === 'running') seen.running = true;
    if (fact.state === 'done' && fact.onMain === true) seen.merged = true;
    byId.set(fact.taskId, seen);
  }
  return byId;
}

/**
 * The slices that write one of `slice`'s files and must be merged before it, by the order of 6.9. Files count, not
 * directories: "a new test file under `ts/`" orders against nothing. For a file the shared-file table names, its writer
 * list orders the writers; a writer that list does not order against the slice is earlier by the turn order, and counts
 * as earlier when either is missing from the turn order. A file no shared-file row names follows the plan's row order,
 * as does a writer the table does not list.
 */
function earlierWriters(plan, slice) {
  const turn = (id) => plan.turnOrder.indexOf(id);
  const earlier = new Map();
  const add = (file, id) => { if (id !== slice.id) earlier.set(id, earlier.get(id) ?? file); };
  for (const file of slice.files.filter((path) => !path.endsWith('/'))) {
    const same = (path) => folded(path) === folded(file);
    const listed = plan.sharedFiles.filter((entry) => entry.files.some(same)).flatMap((entry) => entry.writers);
    const own = listed.indexOf(slice.id);
    for (const [at, writer] of listed.entries()) {
      if (own >= 0 ? at < own : turn(writer) < 0 || turn(slice.id) < 0 || turn(writer) < turn(slice.id)) add(file, writer);
    }
    if (own >= 0) continue;
    for (const other of plan.slices) {
      if (other.line < slice.line && !listed.includes(other.id) && other.files.some(same)) add(file, other.id);
    }
  }
  return earlier;
}

/**
 * Which slices may start now (section 6.8d, "A wave, by fixed rules"). Returns `{ ready, notReady }`: `ready` lists slice
 * IDs in plan order; `notReady` gives every other slice with each reason that holds, `{ code, detail }`, code one of
 * not-allowed, excluded, runbook-only, other-repository, no-files, too-many-files, done, running,
 * dependency-unfinished, earlier-writer-unfinished, same-wave-writer, wave-full. An earlier writer the program never
 * proposes (not allowed, excluded, runbook-only or in another repository) does not hold a slice; a dependency does.
 */
export function readySlices(plan, record, facts) {
  const allow = record?.allow ?? [];
  const exclude = record?.exclude ?? [];
  const byId = factsById(facts);
  const merged = (id) => byId.get(id)?.merged === true;
  const neverProposed = (id) => {
    const writer = plan.slices.find((other) => other.id === id);
    return !allow.some((entry) => coversSlice(entry, id)) || exclude.some((entry) => coversSlice(entry, id)) ||
      writer?.runbookOnly === true || writer?.otherRepository === true;
  };
  const ready = [];
  const notReady = [];
  for (const slice of plan.slices) {
    const reasons = [];
    const why = (code, detail) => reasons.push({ code, detail });
    if (!allow.some((entry) => coversSlice(entry, slice.id))) why('not-allowed', 'the program record does not allow this slice');
    const excluded = exclude.find((entry) => coversSlice(entry, slice.id));
    if (excluded) why('excluded', `the program record excludes ${excluded}`);
    if (slice.runbookOnly) why('runbook-only', 'a runbook-only slice changes the live install and is never proposed');
    if (slice.otherRepository) why('other-repository', 'the slice changes another repository');
    if (!slice.otherRepository && !slice.files.length) why('no-files', 'the Owns cell names no repository file');
    if (slice.files.length > MAX_WRITES) why('too-many-files', `the Owns cell names more than ${MAX_WRITES} files`);
    const fact = byId.get(slice.id);
    if (fact?.done) why('done', 'a task with this ID is done');
    if (fact?.running) why('running', 'a task with this ID is running');
    const open = slice.dependencies.filter((dep) => !merged(dep));
    if (open.length) why('dependency-unfinished', `not yet done with a verified commit on main: ${open.join(', ')}`);
    // A writer the program never proposes has no turn to keep: no wave builds it (#228). Depends on still holds.
    const writers = [...earlierWriters(plan, slice)].filter(([id]) => !merged(id) && !neverProposed(id));
    if (writers.length) {
      why('earlier-writer-unfinished', `an earlier writer of the same file is unfinished: ${writers.map(([id, file]) => `${id} (${file})`).join(', ')}`);
    }
    // Two slices of one wave never share a write domain: the later one waits for the next wave.
    const sharing = reasons.length ? [] : ready.filter((id) => plan.slices.find((other) => other.id === id).files
      .some((path) => slice.files.some((file) => overlaps(path, file))));
    if (sharing.length) why('same-wave-writer', `a slice proposed in this wave writes the same files: ${sharing.join(', ')}`);
    if (!reasons.length && ready.length >= MAX_TASKS) why('wave-full', `a wave holds at most ${MAX_TASKS} tasks`);
    if (reasons.length) notReady.push({ id: slice.id, reasons });
    else ready.push(slice.id);
  }
  return { ready, notReady };
}

function task(slice, record, issue, waveIds) {
  const [, number, title] = /^(\d[\w.]*)\s+(.*)$/.exec(slice.section) ?? [null, null, slice.section];
  const where = number ? `${record.plan} section ${number} (${title})` : `${record.plan} (${title})`;
  const goal = [
    `Build slice ${slice.id} of ${where}, as its row defines it.`,
    `Outcome: ${sentence(slice.outcome)}`,
    `Owns: ${sentence(slice.owns)}`,
    `Depends on: ${sentence(slice.dependsOn)}`,
    `Tests: ${sentence(slice.tests)}`,
  ].join(' ');
  const summary = firstSentence(slice.outcome);
  return {
    id: slice.id,
    issue,
    title: clip(`${slice.id}: ${summary}`, MAX_TITLE),
    outcome: clip(summary, MAX_OUTCOME),
    deliverable: 'commit',
    writes: slice.files,
    goal: clip(goal, MAX_GOAL),
    dependsOn: slice.dependencies.filter((dep) => waveIds.includes(dep)),
    requiresMergedDependencies: true,
    acceptance: [clip(slice.tests, MAX_TEXT)],
    references: [slice.anchor ? `${record.plan}#${slice.anchor}` : record.plan],
  };
}

/**
 * The version 1 declaration `<programId>-w<wave>` for the given ready slice IDs. The record supplies the repository, base
 * branch, plan path, authorization, executor and constraints (copied unchanged); `target` supplies the registered
 * project's `tenantId`, `projectId`, `environment` and `trackingIssue`, which every task names as its issue. Tasks keep
 * plan order, moved only so that a dependency inside the wave is always an earlier task. Throws when `validateDeclaration` refuses it.
 */
export function buildWave(plan, record, { wave, target, ready }) {
  if (!Number.isSafeInteger(wave) || wave < 1) throw new TypeError('wave must be a positive integer');
  const chosen = plan.slices.filter((slice) => ready.includes(slice.id));
  if (!chosen.length) throw new TypeError('a wave needs at least one ready slice');
  const waveIds = chosen.map((slice) => slice.id);
  // Plan order, except that a dependency inside the wave always comes first: the declaration order is topological.
  const slices = [];
  while (slices.length < chosen.length) {
    const next = chosen.find((slice) => !slices.includes(slice) &&
      slice.dependencies.every((dep) => !waveIds.includes(dep) || slices.some((done) => done.id === dep)));
    if (!next) throw new TypeError('the slices of the wave depend on each other in a cycle');
    slices.push(next);
  }
  const declaration = {
    version: 1,
    campaignId: `${record.programId}-w${wave}`,
    authorization: structuredClone(record.authorization),
    target: {
      tenantId: target?.tenantId,
      projectId: target?.projectId,
      environment: target?.environment,
      repository: record.repository,
      baseBranch: record.baseBranch,
      trackingIssue: target?.trackingIssue,
    },
    executor: structuredClone(record.executor),
    constraints: structuredClone(record.constraints),
    tasks: slices.map((slice) => task(slice, record, target?.trackingIssue, waveIds)),
  };
  return validateDeclaration(declaration);
}

/**
 * One proposal from the plan text, the program record and the task facts: `{ declaration, digest, ready, notReady }`.
 * `declaration` and `digest` are null when no slice is ready. The same inputs always give the same declaration and digest.
 */
export function proposeWave({ planText, record, facts, wave, target }) {
  const plan = parsePlan(planText);
  const { ready, notReady } = readySlices(plan, record, facts);
  if (!ready.length) return { declaration: null, digest: null, ready, notReady };
  const declaration = buildWave(plan, record, { wave, target, ready });
  return { declaration, digest: authorityDigest(declaration), ready, notReady };
}
