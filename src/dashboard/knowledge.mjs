// Knowledge and Usage in the dashboard (docs/design/OWNER_UI_V2.md section 9, work package WP8). The rules live in
// src/supervisor/knowledge.mjs; this module finds the project, reads its suggestions and saves the owner's act.
//
// A project's suggestions come only from that project: the README of its own copy (a project without GitHub, at its
// recorded baseline) or of its configured checkout (a GitHub project, at the commit HEAD names), and the plans the AI
// wrote for it. Saving is an owner route (server.mjs: same origin, CSRF token, 16 KiB, JSON) that runs the caller check
// first, so no worker or other program AIWorks started can confirm a fact; it binds the version the page showed and a
// request id.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { MIRROR_REPO, SNAPSHOT_DIR } from '../supervisor/adapters/mirror.mjs';
import { coordinatorUsage, factsKey, KnowledgeError, materialSuggestions, planningEstimate, planSuggestions, projectEvidence, projectKnowledge, saveFact } from '../supervisor/knowledge.mjs';
import { projectOf } from '../supervisor/project-settings.mjs';
import { projects as projectRecords } from '../supervisor/projects.mjs';
import { configuredRepositories } from './projects.mjs';
import { ownerOnly } from './work-list.mjs';
import { typedEvents } from './views.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const LOCAL_ID = /^[\w-]{1,64}$/;
const fail = (status, message, code = null) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const storePath = (dataDir) => join(dataDir, 'supervisor.db');
const UNREADABLE = 'AIWorks can’t read its work records on this computer right now.';
const NOT_FOUND = 'This project is not on this computer. Refresh the page.';
const readConfig = (dataDir) => { try { return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { return {}; } };
const gitOf = (config) => (Array.isArray(config.commands?.git) && config.commands.git.length && config.commands.git.every((part) => typeof part === 'string') ? config.commands.git : ['git']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** The commit HEAD names in a checkout, read-only; null when it cannot be read. */
function headCommit(git, repoPath) {
  if (typeof repoPath !== 'string' || !repoPath || !existsSync(repoPath)) return null;
  const [command, ...prefix] = git;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const out = spawnSync(command, [...prefix, '--no-optional-locks', '-C', repoPath, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000, env });
  const sha = out.error || out.status !== 0 ? '' : out.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * A dashboard project for Knowledge: a GitHub repository AIWorks knows (configured, connected or the target of recorded
 * work), or a connected project by its id. Its facts key, where its README is read and which plans are its own.
 */
function resolveProject(store, dataDir, project) {
  const config = readConfig(dataDir), git = gitOf(config);
  let records = [];
  try { records = projectRecords(store); } catch { records = []; }
  if (typeof project === 'string' && REPOSITORY.test(project)) {
    const record = records.find((row) => row.source_kind === 'github' && same(row.github_repository, project));
    const configured = Object.entries(config.repositories ?? {}).find(([name]) => same(name, project))?.[1];
    const known = Boolean(record || configured) || configuredRepositories(dataDir).some((name) => same(name, project)) ||
      store.all('SELECT declaration FROM campaigns').some((row) => same(projectOf(row.declaration), project));
    if (!known) throw fail(404, NOT_FOUND, 'PROJECT_NOT_FOUND');
    const repoPath = typeof configured?.path === 'string' && configured.path ? configured.path : record?.root_path ?? null;
    return { id: project, key: factsKey(project), git, repoPath, commit: () => headCommit(git, repoPath), plans: record?.id ?? null };
  }
  const record = typeof project === 'string' && LOCAL_ID.test(project) ? records.find((row) => row.id === project) : null;
  if (!record) throw fail(404, NOT_FOUND, 'PROJECT_NOT_FOUND');
  // A project without GitHub is read from AIWorks's own copy at its recorded baseline, never from the owner's folder.
  const local = record.source_kind !== 'github';
  const repoPath = !local ? record.root_path : record.mirror_root ? join(record.mirror_root, record.source_kind === 'folder' ? SNAPSHOT_DIR : MIRROR_REPO) : null;
  const baseline = record.current_baseline?.commit ?? null;
  return { id: project, key: factsKey(project), git, repoPath, commit: () => (local ? baseline : headCommit(git, repoPath)), plans: record.id };
}

/** This project's suggestions as read now: its README, then its own plans. */
function suggestionsOf(store, resolved) {
  const commit = resolved.commit();
  return { commit, list: [...materialSuggestions({ git: resolved.git, repoPath: resolved.repoPath, commit }), ...planSuggestions(store, resolved.plans)] };
}

/** The project's own goals: GitHub work by its repository, work in a project without GitHub by its rules' id. */
function projectCampaigns(store, resolved) {
  let names = [resolved.id];
  try { names = [...names, ...store.all('SELECT id FROM project_overlays WHERE project_id = ?', resolved.id).map((row) => row.id)]; } catch { /* no project was connected */ }
  const rows = store.all('SELECT id, declaration FROM campaigns ORDER BY created_at DESC').filter((row) => names.some((name) => same(projectOf(row.declaration), name)));
  return { ids: rows.map((row) => row.id), name: rows.length ? projectOf(rows[0].declaration) : resolved.id };
}

function view(store, resolved, suggestions) {
  const knowledge = projectKnowledge(store, resolved.key, suggestions.list), goals = projectCampaigns(store, resolved);
  // What approved goals already record and what happened in the project, each with its origin (projectEvidence,
  // typedEvents): read from the store only, never from a file, and never a confirmed fact by itself.
  return { available: true, project: resolved.id, readAt: Date.now(), materials: { readme: suggestions.commit ? suggestions.commit.slice(0, 12) : null }, ...knowledge,
    evidence: projectEvidence(store, goals.ids), history: typedEvents(store, { project: goals.name, limit: 20 }) };
}

/** GET /api/v2/projects/:id/knowledge. Read-only; a missing store is unavailable, never an empty list. */
export function knowledgeView(dataDir, project) {
  if (!existsSync(storePath(dataDir))) throw fail(503, UNREADABLE);
  const store = new Store(storePath(dataDir), { readOnly: true });
  try {
    const resolved = resolveProject(store, dataDir, project);
    return view(store, resolved, suggestionsOf(store, resolved));
  } finally { store.close(); }
}

const REFUSAL_STATUS = { FACT_CHANGED: 409, FACT_REQUEST_REUSED: 409, FACT_SUGGESTION_GONE: 409, FACT_NOT_FOUND: 404, FACT_LIMIT: 409 };
const REFUSAL_WORDS = {
  FACT_CHANGED: 'This fact changed since this page read it. Your words are kept: review the newest version and try again. Nothing was saved.',
  FACT_REQUEST_REUSED: 'This request was already used for another change. Refresh the page; nothing was saved.',
  FACT_SUGGESTION_GONE: 'This suggestion is no longer made: its plan or README changed. Nothing was saved. Write the fact yourself if it is still true.',
  FACT_NOT_FOUND: 'This fact is not kept for this project. Refresh the page; nothing was saved.',
  FACT_SECRET: 'The fact looks like it contains a password or key, so nothing was saved. Remove it and try again.',
  FACT_LIMIT: 'This project already keeps 200 facts. Set one aside before adding another; nothing was saved.',
};
const MESSAGES = { add: 'Saved as a fact you confirmed.', confirm: 'Confirmed. It keeps where it came from.', edit: 'Saved in your words. It keeps where it came from.',
  retire: 'Set aside. It stays in the history and is not suggested again.' };

/**
 * POST /api/v2/projects/knowledge: the owner's act on one fact. input: { requestId, project, action, fact | suggestion,
 * version, text }. The caller check runs first; suggestions are read again here, so a request can only act on one this
 * project makes now.
 */
export async function saveKnowledge(dataDir, input, { caller, now = Date.now() } = {}) {
  const keys = ['requestId', 'project', 'action', 'fact', 'suggestion', 'version', 'text'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)) ||
      !UUID.test(input.requestId ?? '') || typeof input.project !== 'string' || !Number.isSafeInteger(input.version) || input.version < 0 ||
      ['fact', 'suggestion', 'text'].some((key) => input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 1000))) {
    throw fail(400, 'Invalid request.');
  }
  if (!existsSync(storePath(dataDir))) throw fail(503, UNREADABLE);
  const store = new Store(storePath(dataDir));
  try {
    await ownerOnly(store, caller);
    const resolved = resolveProject(store, dataDir, input.project);
    // Git is read before the transaction, so the store is never held while it runs.
    const suggestions = suggestionsOf(store, resolved);
    return store.tx(() => {
      const saved = saveFact(store, { ...input, project: resolved.key }, { suggestions: suggestions.list, now });
      return { ok: true, duplicate: saved.duplicate, fact: saved.factId, version: saved.version,
        message: saved.duplicate ? 'This change was already saved; nothing was saved twice.' : MESSAGES[input.action], view: view(store, resolved, suggestions) };
    });
  } catch (error) {
    if (error instanceof KnowledgeError) throw fail(REFUSAL_STATUS[error.code] ?? 400, REFUSAL_WORDS[error.code] ?? `Not saved: ${error.message}.`, error.code);
    throw error;
  } finally { store.close(); }
}

/** Every campaign's cost by unit (supervisor.mjs costByUnit) added up, each unit on its own: dollars only where reported, tokens per provider. */
function workerUsage(campaigns) {
  const total = { usd: null, usdRuns: 0, unknownRuns: 0, tokens: new Map() };
  for (const campaign of campaigns) {
    const cost = campaign.costByUnit;
    if (!cost) continue;
    if (cost.usd !== null) total.usd = Math.round(((total.usd ?? 0) + cost.usd) * 10000) / 10000;
    total.usdRuns += cost.usdRuns; total.unknownRuns += cost.unknownRuns;
    for (const item of cost.tokens) {
      const sum = total.tokens.get(item.executor) ?? { executor: item.executor, runs: 0, input: 0, output: 0 };
      sum.runs += item.runs; sum.input += item.input; sum.output += item.output;
      total.tokens.set(item.executor, sum);
    }
  }
  return { usd: total.usd, usdRuns: total.usdRuns, unknownRuns: total.unknownRuns, tokens: [...total.tokens.values()] };
}

/**
 * GET /api/v2/settings/usage: usage by source, with unknown kept unknown. AI worker runs (finished, counted runs of all
 * work) and the AI coordinator (planning and messages) by unit; hosting and subscriptions are not tracked by AIWorks and
 * say so, never $0. Read-only.
 */
export function usageView(dataDir, supervisor) {
  if (!supervisor?.available || !existsSync(storePath(dataDir))) return { available: false };
  const store = new Store(storePath(dataDir), { readOnly: true });
  try {
    return { available: true, workers: workerUsage(supervisor.campaigns ?? []), coordinator: coordinatorUsage(store), planning: planningEstimate(store),
      untracked: ['hosting', 'subscriptions'] };
  } finally { store.close(); }
}

/** The planning-cost estimate First run states before anything is planned; unavailable without a store. */
export function planningCost(dataDir) {
  if (!existsSync(storePath(dataDir))) return { available: false, runs: 0, reportedRuns: 0, unknownRuns: 0 };
  let store;
  try { store = new Store(storePath(dataDir), { readOnly: true }); return planningEstimate(store); }
  catch { return { available: false, runs: 0, reportedRuns: 0, unknownRuns: 0 }; } finally { store?.close(); }
}
