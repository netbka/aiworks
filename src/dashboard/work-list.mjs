// The local work list in the dashboard (docs/design/LOCAL_OPERATION.md section 5, LO L13, slice UI20): the list and one
// item with its comments, the owner's decisions for Needs you, the checked local reviews for Results, the read-only preview
// of the imported issues, and the owner's typed confirmation of the exact list to close on GitHub.
//
// Every write is an owner route (server.mjs: same origin, CSRF token, 16 KiB, JSON) and runs the caller check first, so a
// worker or any other program AIWorks started cannot write. A change to an item binds the item's version as the page
// showed it, and every request carries a request id: a retry or a second press answers with the first result and changes
// nothing again. Text is shown as text, never as markup. The import itself stays the CLI's `work-list import` and is not
// run from here; closing on GitHub stays switched off until CLOSE_IMPORTED_ON (SELF11, SELF12).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { OWNER_CALLER } from '../supervisor/local-admission.mjs';
import { mainLedger, recordOwnerMain, selfHostingSettings } from '../supervisor/self-hosting.mjs';
import { addComment, comments, createItem, item, items, setItemState } from '../supervisor/work-list.mjs';
import { CLOSE_IMPORTED_ON, closeCandidates, closeConfirmedIssues, itemVersion } from '../supervisor/work-list-import.mjs';
import { safeText } from './roadmap.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9a-f]{64}$/;
const OWNER_KINDS = Object.freeze(['task', 'note', 'finding', 'decision']);
// What one page shows: the newest items and comments; the body of one item up to this many characters.
const MAX_ITEMS = 500;
const MAX_COMMENTS = 200;
const MAX_SHOWN_BODY = 200_000;
const MAX_REVIEWS = 100;
// An owner's body or comment: 4,000 characters, so text in any script stays within the 16 KiB of a command.
const MAX_TEXT = 4000;
// One confirmation names at most this many issues, so its request stays within the 16 KiB every command is held to.
export const MAX_CONFIRM = 100;
const KIND_WORDS = Object.freeze({ finding: 'Finding', decision: 'Decision', review: 'Checked result', task: 'Task', note: 'Note' });
const AUTHOR_WORDS = Object.freeze({ owner: 'you', supervisor: 'AIWorks', import: 'the GitHub import' });

const fail = (status, message, code = null, detail = null) => Object.assign(new Error(message), { status, ...(code ? { code } : {}), ...(detail ? { detail } : {}) });
const readConfig = (dataDir) => {
  try { const value = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
};
const storePath = (dataDir) => join(dataDir, 'supervisor.db');
const present = (store) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'work_items'"));
const isoTime = (ms) => (Number.isSafeInteger(ms) ? new Date(ms).toISOString() : null);

function readOnly(dataDir, fn, fallback) {
  if (!existsSync(storePath(dataDir))) return fallback;
  let store;
  try { store = new Store(storePath(dataDir), { readOnly: true }); return fn(store); } catch { return fallback; } finally { store?.close(); }
}

/** One list row: allowlisted fields only, never a body. */
const row = (entry) => ({ number: entry.number, kind: entry.kind, kindWord: KIND_WORDS[entry.kind] ?? 'Item', title: safeText(entry.title, 256), state: entry.state,
  labels: (entry.labels ?? []).slice(0, 10).map((label) => safeText(label, 50)), needsOwner: entry.needs_owner === true,
  campaignId: entry.campaign_id ? safeText(entry.campaign_id, 128) : null, taskId: entry.task_id ? safeText(entry.task_id, 128) : null,
  author: AUTHOR_WORDS[entry.author_kind] ?? 'Unknown', updatedAt: isoTime(entry.updated_at) });

/**
 * The checked local reviews (section 5.2): each `review` item the supervisor recorded, with its verified commit, and
 * whether the local merge gate recorded that very commit on main. Checked is never merged, and merged is never accepted.
 */
function reviewRows(store, repository) {
  const merges = repository ? mainLedger(store, repository).filter((entry) => entry.kind === 'gate-merge') : [];
  return store.all(`SELECT number, title, state, campaign_id, task_id, verified_sha, updated_at FROM work_items
    WHERE kind = 'review' AND author_kind = 'supervisor' ORDER BY number DESC LIMIT ${MAX_REVIEWS}`).map((entry) => {
    const merged = merges.find((merge) => merge.verified_sha === entry.verified_sha && merge.campaign_id === entry.campaign_id && merge.task_id === entry.task_id);
    return { number: entry.number, title: safeText(entry.title, 256), state: entry.state, campaignId: entry.campaign_id, taskId: entry.task_id,
      verifiedSha: /^[0-9a-f]{40}$/.test(entry.verified_sha ?? '') ? entry.verified_sha : null, mergedAt: merged ? isoTime(merged.recorded_at) : null,
      updatedAt: isoTime(entry.updated_at) };
  });
}

/**
 * Read-only, for /api/state: whether the work list is in use (a self-hosted repository is set, or items exist), its
 * items without bodies, the open decisions waiting for the owner, the checked reviews, and the import preview: the
 * imported issues this flow has not closed, each with the version a confirmation binds. No GitHub call. `closeOn` is
 * whether closing on GitHub is switched on (tests switch it on with the server's `workList.available`).
 */
export function workListView(dataDir, { closeOn = CLOSE_IMPORTED_ON } = {}) {
  const repository = selfHostingSettings(readConfig(dataDir)).repository;
  const off = { available: Boolean(repository), readable: !existsSync(storePath(dataDir)), repository, items: [], total: 0, decisions: [], reviews: [],
    imported: { candidates: [], closeOn, max: MAX_CONFIRM } };
  return readOnly(dataDir, (store) => {
    if (!present(store)) return { ...off, readable: true };
    const all = items(store);
    const candidates = repository ? closeCandidates(store, repository).map((entry) => ({ ...entry, title: safeText(item(store, entry.number)?.title, 256) })) : [];
    return { available: Boolean(repository) || all.length > 0, readable: true, repository, total: all.length, items: all.slice(0, MAX_ITEMS).map(row),
      decisions: all.filter((entry) => entry.state === 'open' && entry.needs_owner === true && entry.kind === 'decision').map(row),
      reviews: reviewRows(store, repository), imported: { candidates, closeOn, max: MAX_CONFIRM } };
  }, off);
}

/** One item for its own screen: the body (shortened past 200,000 characters), its newest comments and its version. */
export function workItemView(dataDir, number, { textChecks } = {}) {
  if (!Number.isSafeInteger(number) || number < 1) throw fail(404, 'This item is not in the work list on this computer.');
  const view = readOnly(dataDir, (store) => {
    const found = present(store) ? item(store, number) : null;
    if (!found) return null;
    const all = comments(store, number);
    return { ...row(found), version: itemVersion(found), body: textChecks?.read(found.body, MAX_SHOWN_BODY).text ?? safeText(found.body, MAX_SHOWN_BODY), shortened: found.body.length > MAX_SHOWN_BODY,
      verifiedSha: found.verified_sha ?? null, source: found.source_url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(found.source_url)
        ? { url: found.source_url, updatedAt: safeText(found.source_updated_at, 64) } : null,
      createdAt: isoTime(found.created_at), commentCount: all.length,
      comments: all.slice(-MAX_COMMENTS).map((comment) => ({ seq: comment.seq, author: comment.author_kind === 'import' && comment.author ? safeText(comment.author, 100)
        : AUTHOR_WORDS[comment.author_kind] ?? 'Unknown', body: textChecks?.read(comment.body, MAX_SHOWN_BODY).text ?? safeText(comment.body, MAX_SHOWN_BODY), createdAt: isoTime(comment.created_at) })) };
  }, undefined);
  if (view === undefined) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  if (!view) throw fail(404, 'This item is not in the work list on this computer.');
  return view;
}

/** The request's own fields only, each of its kind, before the store is opened. */
function readInput(input, keys, checks) {
  const bad = () => fail(400, 'Invalid request.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) throw bad();
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw bad();
  for (const [key, ok] of Object.entries(checks)) if (!ok(input[key])) throw bad();
  return input;
}
const number = (value) => Number.isSafeInteger(value) && value > 0;
const version = (value) => typeof value === 'string' && VERSION.test(value);
const words = (max, emptyOk = false) => (value) => typeof value === 'string' && value.length <= max && (emptyOk || value.trim().length > 0);

/** The caller check, read as the project rules read it: a program AIWorks started, or no answer, saves nothing. */
export async function ownerOnly(store, caller) {
  const unchecked = (detail) => fail(403, 'AIWorks could not check that this request came from you, so nothing was saved.', 'APPROVAL_UNCHECKED', detail);
  let result = null;
  try { result = typeof caller === 'function' ? await caller(store) : null; } catch (error) {
    if (error?.name !== 'LocalAdmissionError') throw error;
    if (error.code === 'APPROVAL_FROM_AIWORKS') throw fail(403, 'This request came from a program AIWorks started, not from you, so nothing was saved.', error.code);
    throw unchecked(error.message);
  }
  if (result !== OWNER_CALLER) throw unchecked('no caller check is available on this computer');
}

// A request's receipt: its result, kept under its request id in the same transaction as its change. A retry answers it.
const receiptKey = (requestId) => `work-list-request:${requestId.toLowerCase()}`;
const digest = (action, input) => createHash('sha256').update(JSON.stringify([action, Object.entries(input).filter(([key]) => key !== 'requestId')
  .sort(([a], [b]) => a.localeCompare(b))]), 'utf8').digest('hex');
function answered(store, action, input) {
  const saved = store.get('SELECT value FROM meta WHERE key = ?', receiptKey(input.requestId));
  if (!saved) return null;
  let value = null;
  try { value = JSON.parse(saved.value); } catch { value = null; }
  if (value?.digest !== digest(action, input)) throw fail(409, 'This request was already used for another change. Refresh the page; nothing was saved.', 'WORK_REQUEST_REUSED');
  return { ...value.result, duplicate: true };
}
const keep = (store, action, input, result) => {
  store.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', receiptKey(input.requestId), JSON.stringify({ digest: digest(action, input), result }));
  return result;
};

/** A store refusal in the owner's words. */
function refusal(error) {
  if (error?.status || error?.name !== 'WorkListError') return error;
  if (error.code === 'WORK_ITEM_SECRET') return fail(409, 'This text looks like it contains a password or key, so it was not saved. Remove it and try again.', error.code);
  if (error.code === 'WORK_ITEM_NOT_FOUND') return fail(404, 'This item is not in the work list on this computer.', error.code);
  return fail(400, `Not saved: ${error.message}.`, error.code);
}

/** Opens the writable store for one owner change: the caller check first, then the receipt, then the change. */
async function ownerChange(dataDir, caller, action, input, change) {
  if (!existsSync(storePath(dataDir))) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const store = new Store(storePath(dataDir));
  try {
    await ownerOnly(store, caller);
    return store.tx(() => answered(store, action, input) ?? keep(store, action, input, change(store)));
  } catch (error) { throw refusal(error); } finally { store.close(); }
}

/** The item must still be the one the owner saw: any change since (a comment, a state, an edit) saves nothing. */
function sameItem(store, input) {
  const found = item(store, input.number);
  if (!found) throw fail(404, 'This item is not in the work list on this computer.', 'WORK_ITEM_NOT_FOUND');
  if (itemVersion(found) !== input.version) throw fail(409, 'This item changed since you opened it. Read it again; nothing was saved.', 'WORK_ITEM_CHANGED');
  return found;
}

/** POST /api/work-list/items: the owner adds an item. input: { requestId, kind, title, body }. */
export function createWorkItem(dataDir, input, { caller, now = Date.now() } = {}) {
  readInput(input, ['requestId', 'kind', 'title', 'body'], { kind: (value) => OWNER_KINDS.includes(value), title: words(256), body: words(MAX_TEXT, true) });
  return ownerChange(dataDir, caller, 'create', input, (store) => {
    const created = createItem(store, { kind: input.kind, title: input.title.trim(), body: input.body, authorKind: 'owner', now });
    return { ok: true, number: created.number, message: `Added #${created.number} to the work list.` };
  });
}

/** POST /api/work-list/comment: the owner comments on the item as it was shown. input: { requestId, number, version, body }. */
export function commentWorkItem(dataDir, input, { caller, now = Date.now() } = {}) {
  readInput(input, ['requestId', 'number', 'version', 'body'], { number, version, body: words(MAX_TEXT) });
  return ownerChange(dataDir, caller, 'comment', input, (store) => {
    sameItem(store, input);
    addComment(store, { number: input.number, idempotencyKey: `owner-request:${input.requestId.toLowerCase()}`, body: input.body, authorKind: 'owner', now });
    return { ok: true, number: input.number, message: `Comment added to #${input.number}.` };
  });
}

/** POST /api/work-list/state: the owner closes or reopens the item as it was shown. input: { requestId, number, version, state }. */
export function setWorkItemState(dataDir, input, { caller, now = Date.now() } = {}) {
  readInput(input, ['requestId', 'number', 'version', 'state'], { number, version, state: (value) => value === 'open' || value === 'closed' });
  return ownerChange(dataDir, caller, 'state', input, (store) => {
    const found = sameItem(store, input);
    if (found.state === input.state) throw fail(409, `#${input.number} is already ${input.state}. Nothing changed.`, 'WORK_ITEM_SAME_STATE');
    setItemState(store, { number: input.number, state: input.state, now });
    return { ok: true, number: input.number, message: input.state === 'closed' ? `Closed #${input.number} in the work list.` : `Reopened #${input.number}.` };
  });
}

const sha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const TRUST_REFUSALS = Object.freeze({
  TRUSTED_MAIN_MOVED: 'The project changed since you opened this page. Read it again; nothing was recorded.',
  TRUSTED_MAIN_NEEDS_REVIEW: 'These changes affect AIWorks’s worker controls, which need an independent review first. Nothing was recorded.',
  TRUSTED_MAIN_UNKNOWN: 'AIWorks can’t compare the project with its approval records right now, so nothing was recorded.',
  TRUSTED_MAIN_INVALID: 'Not recorded: the request does not match AIWorks’s own repository on this computer.',
});

/**
 * POST /api/v2/settings/trusted-main: the owner trusts the commits they put on local main by hand (LOCAL_OPERATION 4.2,
 * AW-005). input: { requestId, oldTip, newTip }, the exact identities bound to the page's approval control. The caller
 * check runs first; the ledger read, both tips, their ancestry and the paths that need a review are checked again in the
 * transaction that appends the `owner` row (self-hosting.mjs recordOwnerMain). It moves no ref and reviews nothing.
 */
export function recordTrustedMain(dataDir, input, { caller, now = Date.now() } = {}) {
  readInput(input, ['requestId', 'oldTip', 'newTip'], { oldTip: sha, newTip: sha });
  const config = readConfig(dataDir), settings = selfHostingSettings(config);
  if (!settings.local) throw fail(409, 'AIWorks trusts GitHub’s main on this computer, so there is no local main to record.', 'TRUSTED_MAIN_OFF');
  const path = Object.entries(config.repositories ?? {}).find(([name]) => name.toLowerCase() === settings.repository)?.[1]?.path;
  if (typeof path !== 'string' || !path) throw fail(409, TRUST_REFUSALS.TRUSTED_MAIN_UNKNOWN, 'TRUSTED_MAIN_UNKNOWN');
  return ownerChange(dataDir, caller, 'trusted-main', input, (store) => {
    const result = recordOwnerMain(store, { git: config.commands?.git ?? ['git'], repoPath: path, repository: settings.repository,
      oldTip: input.oldTip, newTip: input.newTip, now });
    if (result.already) return { ok: true, recorded: false, message: 'This project version is already trusted. Nothing changed.' };
    if (!result.recorded) throw fail(409, TRUST_REFUSALS[result.code] ?? TRUST_REFUSALS.TRUSTED_MAIN_INVALID, result.code, result.reason);
    return { ok: true, recorded: true, message: 'This project version is trusted. AIWorks recorded your approval.' };
  });
}

const CLOSE_REFUSALS = Object.freeze({
  WORK_CLOSE_OFF: [409, 'Closing the imported issues on GitHub is not switched on in this version of AIWorks. Nothing was sent to GitHub.'],
  WORK_CLOSE_STALE: [409, 'The list changed since you opened it. Review it again; nothing was sent to GitHub.'],
  WORK_CLOSE_INVALID: [400, 'Invalid request.'],
  WORK_CLOSE_FROM_AIWORKS: [403, 'This request came from a program AIWorks started, not from you, so nothing was sent to GitHub.'],
  WORK_CLOSE_UNCHECKED: [403, 'AIWorks could not check that this request came from you, so nothing was sent to GitHub.'],
});

/**
 * POST /api/work-list/close-imported: close on GitHub exactly the imported issues the owner confirmed, typing the
 * repository's name (LOCAL_OPERATION section 5.4, SELF11). input: { requestId, typed, selection: [{ number, version }] },
 * each entry as the preview showed it. The caller check runs first; then the typed name; then closeConfirmedIssues
 * checks every entry against the store, so one changed or foreign entry refuses the whole list before anything is sent.
 * Off until CLOSE_IMPORTED_ON; `available` and the GitHub command are for tests only. A retry with the same request id is
 * answered from its receipt, and an issue already closed by this flow is never commented on or closed again.
 */
export async function closeImportedIssues(dataDir, input, { caller, available = CLOSE_IMPORTED_ON, gh = null, now = Date.now() } = {}) {
  readInput(input, ['requestId', 'typed', 'selection'], { typed: words(200),
    selection: (value) => Array.isArray(value) && value.length > 0 && value.length <= MAX_CONFIRM && value.every((entry) => entry && typeof entry === 'object'
      && !Array.isArray(entry) && Object.keys(entry).every((key) => ['number', 'version'].includes(key)) && number(entry.number) && version(entry.version)) });
  const config = readConfig(dataDir), repository = selfHostingSettings(config).repository;
  if (!repository) throw fail(409, 'No repository is set for AIWorks’s own work list on this computer, so there is nothing to close.', 'WORK_CLOSE_NO_REPOSITORY');
  if (!existsSync(storePath(dataDir))) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const store = new Store(storePath(dataDir));
  try {
    await ownerOnly(store, caller);
    const repeated = store.tx(() => answered(store, 'close', input));
    if (repeated) return repeated;
    if (input.typed.trim().toLowerCase() !== repository) {
      throw fail(409, `Type the repository's name exactly as shown, ${repository}, to confirm. Nothing was sent to GitHub.`, 'WORK_CLOSE_TYPED');
    }
    // Each entry binds the stored import it was shown for; the issue's time at import comes from that same record.
    const selection = input.selection.map((entry) => ({ repository, number: entry.number, updatedAt: item(store, entry.number)?.source_updated_at ?? null, version: entry.version }));
    let report;
    try {
      report = await closeConfirmedIssues({ store, gh: gh ?? config.commands?.gh ?? ['gh'], repository, selection, caller, available, now });
    } catch (error) {
      const known = CLOSE_REFUSALS[error?.code];
      if (known) throw fail(known[0], known[1], error.code, error.code === 'WORK_CLOSE_STALE' ? safeText(error.message, 300) : null);
      throw fail(502, 'GitHub did not confirm every step, so AIWorks stopped. What it finished is recorded; confirm the list again to continue. Nothing is sent twice.', 'WORK_CLOSE_UNFINISHED', safeText(error?.message, 300));
    }
    const result = { ok: true, closed: report.closed, alreadyClosed: report.alreadyClosed,
      skipped: report.skipped.map((entry) => ({ number: entry.number, reason: safeText(entry.reason, 200) })),
      message: [`Closed ${report.closed.length} on GitHub.`, report.alreadyClosed.length ? `${report.alreadyClosed.length} already closed.` : null,
        report.skipped.length ? `${report.skipped.length} skipped because they changed on GitHub.` : null].filter(Boolean).join(' ') };
    return store.tx(() => keep(store, 'close', input, result));
  } finally { store.close(); }
}
