// AIWorks local work list (docs/design/LOCAL_OPERATION.md section 5.1, slice SELF5): items and append-only comments in
// the store, for AIWorks's own repository once local main is trusted. Built switched off: nothing calls the writers until
// publication (SELF7) and the import (SELF10); the CLI `work-list` only reads. Only the owner route and the supervisor
// write; a worker never does. Every text is bounded and refused when it looks like a credential.
import { containsSecret } from './coordinator.mjs';

export const KINDS = Object.freeze(['finding', 'decision', 'review', 'task', 'note']);
export const STATES = Object.freeze(['open', 'closed']);
export const AUTHOR_KINDS = Object.freeze(['owner', 'supervisor', 'import']);
// 1 MiB of UTF-8 per body: larger than GitHub's 65,536 characters, so a verified report is never split.
export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TITLE = 256;
const MAX_LABELS = 50;
const MAX_LABEL = 50;
const MAX_KEY = 200;
const MAX_AUTHOR = 100;
const SHA = /^[0-9a-f]{40}$/;
// New items are numbered after the highest GitHub issue or pull request number seen at import.
const FLOOR_KEY = 'work_list_number_floor';

export class WorkListError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkListError'; this.code = code; }
}
const refuse = (code, message) => { throw new WorkListError(code, message); };

function text(name, value, { max, bytes = false, empty = false }) {
  if (typeof value !== 'string') refuse('WORK_ITEM_INVALID', `${name} must be text`);
  if (!empty && !value.trim()) refuse('WORK_ITEM_INVALID', `${name} must not be empty`);
  const size = bytes ? Buffer.byteLength(value, 'utf8') : value.length;
  if (size > max) refuse('WORK_ITEM_TOO_LARGE', `${name} is ${size} ${bytes ? 'bytes' : 'characters'}; the limit is ${max}`);
  // The same check as coordinator replies: text that looks like a credential is never stored.
  if (containsSecret(value)) refuse('WORK_ITEM_SECRET', `${name} looks like it contains a credential; it was not recorded`);
  return value;
}
const oneOf = (name, value, allowed) => (allowed.includes(value) ? value : refuse('WORK_ITEM_INVALID', `${name} must be one of ${allowed.join(', ')}`));
const optional = (name, value, max) => (value === undefined || value === null ? null : text(name, value, { max }));
const at = (name, value) => (Number.isSafeInteger(value) && value >= 0 ? value : refuse('WORK_ITEM_INVALID', `${name} must be a time in milliseconds`));

function labelList(labels = []) {
  if (!Array.isArray(labels) || labels.length > MAX_LABELS) refuse('WORK_ITEM_INVALID', `labels must be a list of at most ${MAX_LABELS}`);
  return [...new Set(labels.map((label) => text('a label', label, { max: MAX_LABEL })))];
}

const present = (store) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'work_items'"));
const decode = (row) => row && { ...row, labels: JSON.parse(row.labels), needs_owner: row.needs_owner === 1 };

/** The number the next new item gets: after every item and after the import's floor. */
export function nextNumber(store) {
  const highest = store.get('SELECT MAX(number) AS n FROM work_items')?.n ?? 0;
  const floor = Number(store.get('SELECT value FROM meta WHERE key = ?', FLOOR_KEY)?.value ?? 0);
  return Math.max(highest, floor) + 1;
}

/** Raise the floor to the highest GitHub issue or pull request number seen (the import calls it). It never goes down. */
export function raiseNumberFloor(store, highest) {
  if (!Number.isSafeInteger(highest) || highest < 0) refuse('WORK_ITEM_INVALID', 'the number floor must be a whole number');
  return store.tx(() => {
    const floor = Number(store.get('SELECT value FROM meta WHERE key = ?', FLOOR_KEY)?.value ?? 0);
    if (highest > floor) store.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', FLOOR_KEY, String(highest));
    return Math.max(highest, floor);
  });
}

/**
 * Create an item. A new item takes the next number; an imported one (authorKind 'import') keeps its GitHub `number`,
 * refused when that number is taken. `source` ({ url, updatedAt }) is the GitHub issue an imported item came from.
 */
export function createItem(store, { number = null, kind, title, body = '', labels = [], needsOwner = false,
  links = {}, source = null, authorKind, now }) {
  oneOf('kind', kind, KINDS);
  oneOf('authorKind', authorKind, AUTHOR_KINDS);
  const row = {
    kind, title: text('title', title, { max: MAX_TITLE }), body: text('body', body, { max: MAX_BODY_BYTES, bytes: true, empty: true }),
    state: 'open', labels: JSON.stringify(labelList(labels)), needs_owner: needsOwner === true ? 1 : 0,
    campaign_id: optional('the campaign link', links.campaignId, MAX_KEY), task_id: optional('the task link', links.taskId, MAX_KEY),
    verified_sha: links.verifiedSha === undefined || links.verifiedSha === null ? null
      : SHA.test(String(links.verifiedSha)) ? links.verifiedSha : refuse('WORK_ITEM_INVALID', 'the verified SHA must be a full commit SHA'),
    source_url: optional('the source URL', source?.url, 2048), source_updated_at: optional('the source time', source?.updatedAt, 64),
    author_kind: authorKind, created_at: at('now', now), updated_at: now,
  };
  if ((number !== null) !== (authorKind === 'import')) refuse('WORK_ITEM_INVALID', 'only an imported item keeps a number of its own');
  if (number !== null && (!Number.isSafeInteger(number) || number < 1)) refuse('WORK_ITEM_INVALID', 'an item number is a whole number from 1');
  return store.tx(() => {
    const assigned = number ?? nextNumber(store);
    if (store.get('SELECT 1 AS taken FROM work_items WHERE number = ?', assigned)) refuse('WORK_ITEM_EXISTS', `work item #${assigned} already exists`);
    store.insert('work_items', { number: assigned, ...row });
    return item(store, assigned);
  });
}

/** Open or close an item. Closing is the only way an item leaves the list: an item is never deleted. */
export function setItemState(store, { number, state, now }) {
  oneOf('state', state, STATES);
  return store.tx(() => {
    if (!store.get('SELECT 1 AS present FROM work_items WHERE number = ?', number)) refuse('WORK_ITEM_NOT_FOUND', `no work item #${number}`);
    store.run('UPDATE work_items SET state = ?, updated_at = ? WHERE number = ?', state, at('now', now), number);
    return item(store, number);
  });
}

/**
 * Append a comment. `idempotencyKey` plays the role of today's GitHub comment marker: a second call with the same key,
 * after a crash or a restart, records nothing and returns the first comment with `created: false`.
 */
export function addComment(store, { number, idempotencyKey, body, authorKind, author = null, createdAt, now }) {
  const key = text('the idempotency key', idempotencyKey, { max: MAX_KEY });
  const row = { idempotency_key: key, body: text('the comment', body, { max: MAX_BODY_BYTES, bytes: true }),
    author_kind: oneOf('authorKind', authorKind, AUTHOR_KINDS), author: optional('the author', author, MAX_AUTHOR),
    created_at: at('createdAt', createdAt ?? now), recorded_at: at('now', now) };
  return store.tx(() => {
    if (!store.get('SELECT 1 AS present FROM work_items WHERE number = ?', number)) refuse('WORK_ITEM_NOT_FOUND', `no work item #${number}`);
    const existing = store.get('SELECT * FROM work_item_comments WHERE item_number = ? AND idempotency_key = ?', number, key);
    if (existing) return { created: false, comment: existing };
    const seq = Number(store.run(`INSERT INTO work_item_comments (item_number, idempotency_key, body, author_kind, author, created_at, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, number, row.idempotency_key, row.body, row.author_kind, row.author, row.created_at, row.recorded_at).lastInsertRowid);
    store.run('UPDATE work_items SET updated_at = ? WHERE number = ?', now, number);
    return { created: true, comment: store.get('SELECT * FROM work_item_comments WHERE seq = ?', seq) };
  });
}

/** One item, or null. A read-only open of a store older than the work list has none. */
export function item(store, number) {
  return present(store) ? decode(store.get('SELECT * FROM work_items WHERE number = ?', number)) : null;
}

/** Every item without its body, newest number first; `state` narrows to open or closed items. */
export function items(store, { state = null } = {}) {
  if (!present(store)) return [];
  if (state !== null) oneOf('state', state, STATES);
  return store.all(`SELECT number, kind, title, state, labels, needs_owner, campaign_id, task_id, author_kind, created_at, updated_at
    FROM work_items ${state ? 'WHERE state = ?' : ''} ORDER BY number DESC`, ...(state ? [state] : [])).map(decode);
}

/** The comments of one item, in the order they were recorded. */
export function comments(store, number) {
  return present(store) ? store.all('SELECT * FROM work_item_comments WHERE item_number = ? ORDER BY seq', number) : [];
}
