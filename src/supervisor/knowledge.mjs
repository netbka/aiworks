// Product knowledge and honest planning cost (docs/design/OWNER_UI_V2.md section 9, work package WP8).
//
// A project's facts come in three kinds, and the kind never changes by itself:
// - confirmed by the owner: a row of `project_facts`. Every row is the owner's own act on the dashboard (saveFact, after
//   the caller check): a fact written, a suggestion confirmed, edited or set aside. Nothing else writes the table, so no
//   worker, plan or file can make a fact confirmed;
// - found in material: a sentence quoted from the project's own README at a named commit (materialSuggestions);
// - suggested by AI: what a plan the AI wrote says the goal delivers (planSuggestions), with the request and version.
// Suggestions are derived when the page reads them and are never stored as facts. Confirming or editing one keeps where
// it came from (`basis`) in every later version, so an edited fact still says it was first suggested by AI or found in
// material. Facts are read only by the owner's Knowledge page: they are not given to workers, carry no field for files,
// providers, budgets or release, and never change a plan, a declaration or its authority.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from './campaign.mjs';
import { SECRET_LIKE_PATH_PATTERN } from '../../scripts/lib/worker-context.mjs';
import { containsSecret } from './coordinator.mjs';
import { draftOutline } from './intake.mjs';
import { containsKnownSecretValue } from '../shared/credential-metadata.mjs';

export class KnowledgeError extends Error {
  constructor(code, message) { super(message); this.name = 'KnowledgeError'; this.code = code; }
}
const refuse = (code, message) => { throw new KnowledgeError(code, message); };

export const MAX_FACT = 400;
export const MAX_FACTS = 200;
const MAX_README_BYTES = 64 * 1024;
const MATERIAL_SENTENCES = 4;
const PLAN_ITEMS = 40;
const SHA = /^[0-9a-f]{40}$/;
const README = /^readme(?:\.md|\.markdown|\.txt)?$/i;
const ACTIONS = ['add', 'confirm', 'edit', 'retire'];

/** The key facts are kept under: a GitHub repository or a connected project's id, case folded. Null for anything else. */
export const factsKey = (project) => (typeof project === 'string' && /^(?:[\w.-]+\/[\w.-]+|[\w-]{1,64})$/.test(project) ? project.toLowerCase() : null);
const hasTable = (store, name) => Boolean(store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name));
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const unsafe = (text) => containsSecret(text) || containsKnownSecretValue(text);

/** One read-only Git command; inherited GIT_* variables could point Git elsewhere. Null when it fails. */
function readGit(git, repoPath, args) {
  const [command, ...prefix] = git;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const result = spawnSync(command, [...prefix, '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repoPath, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, env });
  return result.error || result.status !== 0 ? null : result.stdout;
}

/** The first paragraph of a README in plain words: headings, badges, code, lists, quotes, tables and markup are skipped. */
export function firstParagraph(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const paragraph = [];
  let fenced = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { fenced = !fenced; if (paragraph.length) break; continue; }
    if (fenced) continue;
    const prose = line && !/^(?:#|!\[|\[!\[|<|[-*+>|]|\d+[.)]\s|=+$|-+$)/.test(line);
    if (prose) paragraph.push(line);
    else if (paragraph.length) break;
  }
  // A link reads as its words; the address is not part of the fact.
  return paragraph.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
}

/**
 * Found in material: up to four sentences of the first paragraph of the README at the top of the project's tree, quoted
 * as written, each with the file and commit it was read from. Read from Git objects of `commit` only; nothing is checked
 * out, run or written. A sentence that looks like it holds a credential is left out. None when there is no such file.
 */
export function materialSuggestions({ git = ['git'], repoPath, commit }) {
  if (typeof repoPath !== 'string' || !repoPath || !SHA.test(commit ?? '')) return [];
  const names = readGit(git, repoPath, ['ls-tree', '--name-only', '-z', commit]);
  const name = names?.split('\0').find((entry) => README.test(entry));
  if (!name) return [];
  const size = Number(readGit(git, repoPath, ['cat-file', '-s', `${commit}:${name}`]));
  if (!Number.isSafeInteger(size) || size > MAX_README_BYTES) return [];
  const text = readGit(git, repoPath, ['cat-file', 'blob', `${commit}:${name}`]);
  if (text === null) return [];
  return firstParagraph(text).split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/u).map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12 && sentence.length <= MAX_FACT && !unsafe(sentence)).slice(0, MATERIAL_SENTENCES)
    .map((sentence) => ({ source: 'material', text: sentence, origin: { path: name, commit } }));
}

/**
 * Suggested by AI: what each plan of the project says its goal delivers ("included"), from the newest version of each
 * plan the AI wrote. A version the owner edited is a plan, not a suggestion, so it gives none. `projectId` is the
 * connected project's id: plans are never read across projects.
 */
export function planSuggestions(store, projectId) {
  if (typeof projectId !== 'string' || !hasTable(store, 'work_drafts')) return [];
  const out = [];
  for (const request of store.all('SELECT request_id FROM work_requests WHERE project_id = ? ORDER BY id DESC LIMIT 20', projectId)) {
    const draft = store.get('SELECT * FROM work_drafts WHERE request_id = ? ORDER BY version DESC LIMIT 1', request.request_id);
    if (!draft || draft.project_id !== projectId || draft.edited_from != null) continue;
    const included = draftOutline(draft).included;
    for (const item of Array.isArray(included) ? included : []) {
      if (typeof item !== 'string' || !item.trim() || item.length > MAX_FACT || unsafe(item)) continue;
      out.push({ source: 'ai', text: item.trim(), origin: { requestId: request.request_id, version: draft.version,
        goal: typeof draft.declaration?.envelope?.outcome === 'string' ? draft.declaration.envelope.outcome.slice(0, 300) : null } });
    }
  }
  return out.slice(0, PLAN_ITEMS);
}

const EVIDENCE_GOALS = 20, EVIDENCE_ITEMS = 12, EVIDENCE_REFERENCES = 40, EVIDENCE_DECISIONS = 20;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OPTION = /^[a-z][a-z0-9-]{0,31}$/;
const SAFE_REFERENCE = /^[\w.-]+(?:\/[\w.-]+)*(?:#[a-z0-9_-]{1,160})?$/;
const secretPath = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');
const plainText = (value, max) => (typeof value === 'string' && value.trim() && value.length <= max && !unsafe(value) && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null);

/**
 * What the project's approved goals already record, for Knowledge (OWNER_UI_V2 screen 8), never a fact by itself:
 * - requirements: each goal's done-when criteria as its approved declaration states them, with that goal and its
 *   authorization version as their origin; an approved plan's words, not a fact the owner confirmed here;
 * - decisions: the owner's recorded answers to step decisions (events `decision-answer`): which step, when, and the
 *   option chosen or that it was answered in their own words; the words themselves stay in the decision's event;
 * - references: the repository-relative documents the approved steps name, by path and section only. Nothing here reads
 *   a file: a name that is not a plain relative path, or looks like a secret, is left out and counted.
 * `campaignIds` are the project's own goals (the caller matches them to the project). Allowlisted fields only.
 */
export function projectEvidence(store, campaignIds) {
  const requirements = [], decisions = [], references = new Map();
  let withheld = 0;
  for (const id of campaignIds.slice(0, EVIDENCE_GOALS)) {
    const c = store.campaign(id);
    if (!c) continue;
    const d = c.declaration, registered = store.get("SELECT at FROM journal WHERE campaign_id = ? AND kind = 'registered' ORDER BY seq LIMIT 1", id);
    const origin = { campaignId: id, goal: plainText(d.purpose, 300) ?? plainText(d.envelope?.outcome, 300), authorizationVersion: c.authorization_version,
      approvedAt: registered?.at ?? c.created_at, control: c.control };
    const criteria = Array.isArray(d.envelope?.acceptance) ? d.envelope.acceptance : d.tasks.flatMap((task) => task.acceptance ?? []);
    const texts = [...new Set(criteria.map((item) => plainText(item, MAX_FACT)).filter(Boolean))].slice(0, EVIDENCE_ITEMS);
    if (texts.length) requirements.push({ ...origin, criteria: texts });
    for (const task of d.tasks) {
      for (const reference of Array.isArray(task.references) ? task.references : []) {
        const name = typeof reference === 'string' ? reference : null;
        if (!name || !SAFE_REFERENCE.test(name) || name.split(/[/#]/).some((part) => part === '..' || part === '.') || secretPath.test(name.split('#')[0])) { withheld += 1; continue; }
        const entry = references.get(name) ?? { reference: name, goals: [] };
        if (!entry.goals.includes(id)) entry.goals.push(id);
        references.set(name, entry);
      }
    }
    const steps = new Map(d.tasks.map((task) => [task.id, plainText(task.outcome ?? task.title, 300)]));
    for (const event of store.all("SELECT payload, received_at FROM events WHERE campaign_id = ? AND kind = 'decision-answer' ORDER BY seq DESC LIMIT ?", id, EVIDENCE_DECISIONS)) {
      const taskId = STEP_ID.test(event.payload?.taskId ?? '') ? event.payload.taskId : null;
      if (!taskId) continue;
      decisions.push({ campaignId: id, goal: origin.goal, taskId, step: steps.get(taskId) ?? null, at: event.received_at,
        option: OPTION.test(event.payload?.option ?? '') ? event.payload.option : null, ownWords: typeof event.payload?.text === 'string' });
    }
  }
  return { requirements, decisions: decisions.sort((a, b) => b.at - a.at).slice(0, EVIDENCE_DECISIONS),
    references: [...references.values()].slice(0, EVIDENCE_REFERENCES), withheldReferences: withheld + Math.max(0, references.size - EVIDENCE_REFERENCES) };
}

/** A suggestion's stable key: its project, kind, origin and words. The same suggestion keeps its key on every read. */
export const suggestionKey = (key, suggestion) => `s-${sha256(canonicalJson([key, suggestion.source, suggestion.origin, suggestion.text])).slice(0, 20)}`;

const ACT_WORDS = { add: 'written', confirm: 'confirmed', edit: 'edited', retire: 'set-aside' };

/**
 * The Knowledge page: the owner's facts (each with every version) and the suggestions not acted on yet, keyed. Allowlisted
 * fields only; `suggestions` are this project's own (materialSuggestions, planSuggestions).
 */
export function projectKnowledge(store, project, suggestions = []) {
  const key = factsKey(project);
  const rows = key && hasTable(store, 'project_facts') ? store.all('SELECT * FROM project_facts WHERE project = ? ORDER BY fact_id, version', key) : [];
  const byId = new Map();
  for (const row of rows) {
    const history = byId.get(row.fact_id) ?? [];
    history.push({ version: row.version, text: row.text, state: row.state, act: row.state === 'retired' ? 'set-aside' : row.version === 1 ? (row.basis ? 'confirmed' : 'written')
      : history.at(-1)?.state === 'retired' ? 'restored' : 'edited', at: row.created_at, basis: row.basis ?? null });
    byId.set(row.fact_id, history);
  }
  const facts = [...byId.entries()].map(([id, history]) => {
    const last = history.at(-1), basis = history[0].basis;
    return { id, version: last.version, text: last.text, state: last.state, basis, edited: Boolean(basis) && last.text !== basis.text,
      createdAt: history[0].at, updatedAt: last.at, history: history.map(({ basis: _, ...entry }) => entry) };
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const seen = new Set(byId.keys());
  const open = [];
  for (const suggestion of suggestions) {
    const id = suggestionKey(key, suggestion);
    if (!seen.has(id)) { seen.add(id); open.push({ key: id, ...suggestion }); }
  }
  return { facts, suggestions: open, limits: { text: MAX_FACT, facts: MAX_FACTS } };
}

/** A fact's words: one line of 1..400 characters, never a credential. */
function factText(value) {
  if (typeof value !== 'string') refuse('FACT_TEXT', 'a fact is text');
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_FACT || /[\u0000-\u001f\u007f]/.test(text)) refuse('FACT_TEXT', `a fact is one line of 1 to ${MAX_FACT} characters`);
  if (unsafe(text)) refuse('FACT_SECRET', 'the fact looks like it contains a credential');
  return text;
}

/**
 * The owner's act on one fact, as its next version, bound to the version the page showed and to a request id; the
 * caller ran the caller check and holds the transaction. input: { project, action, fact | suggestion, version,
 * requestId, text }:
 *   add      a new fact in the owner's words (version 0);
 *   confirm  a suggestion, in its own words (version 0): it keeps where it came from;
 *   edit     a fact, or a suggestion (version 0), in the owner's words: confirmed, and still saying where it came from;
 *   retire   set a fact aside, or a suggestion (version 0) so it is not suggested again.
 * `suggestions` are this project's suggestions as read now: a suggestion is acted on only while it is one of them, so
 * no request names another project's material or plan, or makes up an origin. Refusals: FACT_REQUEST, FACT_ACTION,
 * FACT_TEXT, FACT_SECRET, FACT_NOT_FOUND, FACT_SUGGESTION_GONE, FACT_CHANGED, FACT_LIMIT, FACT_REQUEST_REUSED.
 */
export function saveFact(store, input, { suggestions = [], now = Date.now() } = {}) {
  const key = factsKey(input?.project);
  if (!key) refuse('FACT_NOT_FOUND', 'facts belong to a project');
  if (typeof input.requestId !== 'string' || !/^[\w-]{8,80}$/.test(input.requestId)) refuse('FACT_REQUEST', 'a change needs a request id');
  if (!ACTIONS.includes(input.action) || (input.action === 'add') === Boolean(input.fact ?? input.suggestion) || (input.fact && input.suggestion)) {
    refuse('FACT_ACTION', 'add names no fact; confirm, edit and retire name one fact or one suggestion');
  }
  if (input.action === 'confirm' && !input.suggestion) refuse('FACT_ACTION', 'only a suggestion is confirmed; edit a fact to change it');
  if (!Number.isSafeInteger(input.version) || input.version < 0) refuse('FACT_ACTION', 'a change names the version it was made from');
  const text = ['add', 'edit'].includes(input.action) ? factText(input.text) : null;
  const digest = `sha256:${sha256(canonicalJson({ project: key, action: input.action, fact: input.fact ?? null, suggestion: input.suggestion ?? null, version: input.version, text }))}`;
  const kept = store.get('SELECT * FROM project_facts WHERE request_id = ?', input.requestId.toLowerCase());
  if (kept) {
    if (kept.project !== key || kept.digest !== digest) refuse('FACT_REQUEST_REUSED', 'this request id was already used for another change');
    return { factId: kept.fact_id, version: kept.version, duplicate: true };
  }
  const newest = (id) => store.get('SELECT * FROM project_facts WHERE project = ? AND fact_id = ? ORDER BY version DESC LIMIT 1', key, id);
  let factId, version, state = 'active', basis = null, words = text;
  if (input.action === 'add') {
    if (input.version !== 0) refuse('FACT_CHANGED', 'a new fact starts at version 0');
    factId = `f-${randomBytes(6).toString('hex')}`; version = 1;
  } else if (input.suggestion) {
    const found = suggestions.find((item) => suggestionKey(key, item) === input.suggestion);
    if (!found) refuse('FACT_SUGGESTION_GONE', 'this suggestion is no longer made for this project');
    if (newest(input.suggestion) || input.version !== 0) refuse('FACT_CHANGED', 'this suggestion was already acted on');
    factId = input.suggestion; version = 1;
    basis = { source: found.source, origin: found.origin, text: found.text };
    if (input.action === 'confirm') words = found.text;
    if (input.action === 'retire') { words = found.text; state = 'retired'; }
  } else {
    const current = typeof input.fact === 'string' ? newest(input.fact) : null;
    if (!current) refuse('FACT_NOT_FOUND', 'this fact is not kept for this project');
    if (current.version !== input.version) refuse('FACT_CHANGED', `the fact changed since version ${input.version}: version ${current.version} is the newest`);
    if (input.action === 'retire' && current.state === 'retired') refuse('FACT_CHANGED', 'this fact is already set aside');
    factId = current.fact_id; version = current.version + 1;
    // Where the fact came from is kept with every version: the first version's basis.
    basis = store.get('SELECT basis FROM project_facts WHERE project = ? AND fact_id = ? AND version = 1', key, factId)?.basis ?? null;
    if (input.action === 'retire') { words = current.text; state = 'retired'; }
  }
  if (version === 1 && store.get('SELECT COUNT(DISTINCT fact_id) AS n FROM project_facts WHERE project = ?', key).n >= MAX_FACTS) {
    refuse('FACT_LIMIT', `a project keeps up to ${MAX_FACTS} facts`);
  }
  store.run('INSERT INTO project_facts (project, fact_id, version, text, state, basis, digest, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    key, factId, version, words, state, basis === null ? null : JSON.stringify(basis), digest, input.requestId.toLowerCase(), now);
  store.journal(null, 'project-fact-saved', { project: key, fact: factId, version, act: ACT_WORDS[input.action], basis: basis?.source ?? null }, now);
  return { factId, version, duplicate: false };
}

/**
 * What planning a goal has cost on this computer: the dollars reported by the last 20 finished planning runs (the AI
 * coordinator's intake runs). Unavailable, never $0, until at least one reported its cost; runs that reported none are
 * counted apart and never priced. An estimate from history, not a quote: the next plan may cost more or less.
 */
export function planningEstimate(store) {
  if (!hasTable(store, 'coordinator_runs')) return { available: false, runs: 0, reportedRuns: 0, unknownRuns: 0 };
  const runs = store.all("SELECT cost_usd FROM coordinator_runs WHERE id LIKE 'intake.%' AND state IN ('answered', 'failed') ORDER BY created_at DESC LIMIT 20");
  const reported = runs.map((run) => run.cost_usd).filter((cost) => Number.isFinite(cost) && cost > 0).sort((a, b) => a - b);
  const base = { runs: runs.length, reportedRuns: reported.length, unknownRuns: runs.length - reported.length };
  if (!reported.length) return { available: false, ...base };
  const round = (value) => Math.round(value * 100) / 100;
  const middle = reported.length % 2 ? reported[(reported.length - 1) / 2] : (reported[reported.length / 2 - 1] + reported[reported.length / 2]) / 2;
  return { available: true, ...base, lowUsd: round(reported[0]), medianUsd: round(middle), highUsd: round(reported.at(-1)) };
}

/**
 * The AI coordinator's runs by unit (planning goals and answering messages): reported dollars (null, never 0, when none
 * reported), and the runs that reported none, counted apart.
 */
export function coordinatorUsage(store) {
  if (!hasTable(store, 'coordinator_runs')) return { runs: 0, usd: null, reportedRuns: 0, unknownRuns: 0, openRuns: 0 };
  const runs = store.all('SELECT state, cost_usd FROM coordinator_runs');
  const finished = runs.filter((run) => !['recorded', 'dispatched'].includes(run.state));
  const reported = finished.filter((run) => Number.isFinite(run.cost_usd) && run.cost_usd > 0);
  return { runs: runs.length, usd: reported.length ? Math.round(reported.reduce((sum, run) => sum + run.cost_usd, 0) * 10000) / 10000 : null,
    reportedRuns: reported.length, unknownRuns: finished.length - reported.length, openRuns: runs.length - finished.length };
}
