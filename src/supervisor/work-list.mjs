// AIWorks local work list (docs/design/LOCAL_OPERATION.md section 5.1, slice SELF5): items and append-only comments in
// the store, for AIWorks's own repository once local main is trusted. Publication (SELF7) writes reviews, reports and
// notes of the self-hosted repository here; the import (SELF10, work-list-import.mjs) writes imported issues. Only
// the owner route and the supervisor write; a worker never does. Every text is bounded and refused when it looks like a
// credential.
import { createHash } from 'node:crypto';
import { containsSecret } from './coordinator.mjs';
import { trustsLocalMain } from './self-hosting.mjs';

export const KINDS = Object.freeze(['finding', 'decision', 'review', 'task', 'note']);
export const STATES = Object.freeze(['open', 'closed']);
export const AUTHOR_KINDS = Object.freeze(['owner', 'supervisor', 'import']);
// 1 MiB of UTF-8 per body: larger than GitHub's 65,536 characters, so a verified report is never split.
export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TITLE = 256;
const MAX_LABELS = 50;
const MAX_LABEL = 50;
const MAX_KEY = 300;
const MAX_AUTHOR = 100;
const SHA = /^[0-9a-f]{40}$/;
// A declaration of the self-hosted repository may name its owner authorization as a work item (section 5.2).
export const WORK_REFERENCE = /^aiworks-work:([1-9]\d{0,8})$/;
/** How publication names a work item in a task's result link and in the outbox target. */
export const workLink = (number) => `aiworks-work:${number}`;
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

/**
 * The newest `review` item the supervisor recorded for a campaign's task, optionally at exactly `verifiedSha`, or null.
 * It is the stable identity of a published commit: a retry finds it instead of recording a second one.
 */
export function reviewItem(store, { campaignId, taskId, verifiedSha = null }) {
  if (!present(store)) return null;
  return decode(store.get(`SELECT * FROM work_items WHERE kind = 'review' AND author_kind = 'supervisor' AND campaign_id = ? AND task_id = ?
    ${verifiedSha ? 'AND verified_sha = ?' : ''} ORDER BY number DESC LIMIT 1`, campaignId, taskId, ...(verifiedSha ? [verifiedSha] : [])));
}

export const FOLLOW_UP = 'follow-up';

/**
 * AW-017: the follow-up item for a step AIWorks finished by itself (delivered with known defects, or ended as not done).
 * One per campaign, step and `key`, so a retry after a crash records nothing twice. Text that looks like a credential is
 * never stored: the item is then recorded with a plain title and `fallback`, a body without the refused text. Not for the
 * owner to answer: AIWorks plans it like any other work item.
 */
export function followUp(store, { campaignId, taskId, key, title, body, fallback, verifiedSha = null, subject = null, now }) {
  const label = `${FOLLOW_UP}:${String(key).slice(0, MAX_LABEL - FOLLOW_UP.length - 1)}`;
  const found = present(store) && store.get(`SELECT number FROM work_items WHERE kind = 'task' AND author_kind = 'supervisor' AND campaign_id = ? AND task_id = ?
    AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?) LIMIT 1`, campaignId, taskId, label);
  if (found) return item(store, found.number);
  // The same work run again (another campaign with the same subject) that is again not done adds one comment to the
  // open item instead of a second item, so retries of one request never pile up.
  const open = subject && key === NOT_DONE && openSubjectItem(store, subject);
  if (open) {
    addComment(store, { number: open.number, idempotencyKey: `again:${campaignId}:${taskId}`, authorKind: 'supervisor', now,
      body: `Not done again in campaign ${campaignId}, step ${taskId}. ${containsSecret(body) ? fallback : body}`.slice(0, MAX_BODY_BYTES / 4) });
    return item(store, open.number);
  }
  const links = { campaignId, taskId, verifiedSha };
  const labels = [FOLLOW_UP, label, ...(subject ? [subject] : [])];
  try {
    return createItem(store, { kind: 'task', title, body, labels, links, authorKind: 'supervisor', now });
  } catch (error) {
    if (error?.code !== 'WORK_ITEM_SECRET' && error?.code !== 'WORK_ITEM_TOO_LARGE') throw error;
    return createItem(store, { kind: 'task', title: `Follow-up for step ${taskId}`, body: fallback, labels, links, authorKind: 'supervisor', now });
  }
}

const NOT_DONE = 'not-done';
const SUBJECT = 'subject';

/**
 * The subject of a campaign step: the same declared work (target, purpose, step) under whatever campaign id it is run.
 * A label, so a later run of the same work finds the earlier run's not-done follow-up. Null without a purpose.
 */
export function subjectLabel(declaration, taskId) {
  const target = declaration?.target?.repository ?? declaration?.target?.projectId ?? null;
  if (!target || typeof declaration?.purpose !== 'string' || !declaration.purpose.trim()) return null;
  // The step's own title and goal too, so unrelated campaigns that reuse a generic purpose and step id never share a
  // subject. A retry whose goal differs gets its own item: more items, never a wrong close.
  const task = (declaration.tasks ?? []).find((t) => t?.id === taskId);
  if (!task || typeof task.goal !== 'string' || !task.goal.trim()) return null;
  const digest = createHash('sha256').update(JSON.stringify([target, declaration.purpose.trim(), taskId, task.title ?? null, task.goal.trim()]), 'utf8')
    .digest('hex').slice(0, 24);
  return `${SUBJECT}:${digest}`;
}

const openSubjectItem = (store, subject) => present(store) && store.get(`SELECT number FROM work_items WHERE kind = 'task' AND author_kind = 'supervisor'
  AND state = 'open' AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?) AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?)
  ORDER BY number LIMIT 1`, subject, `${FOLLOW_UP}:${NOT_DONE}`);

/**
 * A step finished done: the open not-done follow-ups of the same subject from other campaigns are settled by it. Each is
 * closed with one comment naming the campaign that finished the work. Known-defect follow-ups stay open: a later pass
 * of the same work does not show their defects were fixed. Returns the closed item numbers.
 */
export function settleSubject(store, { subject, campaignId, taskId, now }) {
  if (!subject || !present(store)) return [];
  const rows = store.all(`SELECT number FROM work_items WHERE kind = 'task' AND author_kind = 'supervisor' AND state = 'open'
    AND (campaign_id IS NULL OR campaign_id <> ?) AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?)
    AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?)`, campaignId, subject, `${FOLLOW_UP}:${NOT_DONE}`);
  for (const { number } of rows) {
    addComment(store, { number, idempotencyKey: `settled:${campaignId}:${taskId}`, authorKind: 'supervisor', now,
      body: `Settled: the same work finished in campaign ${campaignId}, step ${taskId}.` });
    setItemState(store, { number, state: 'closed', now });
  }
  return rows.map((row) => row.number);
}

/**
 * The open not-done follow-up items AIWorks filed for the steps of one campaign, or of every campaign: { number,
 * campaign_id, task_id }, oldest first. Empty when this installation has no work list.
 */
export function openNotDoneItems(store, campaignId = null) {
  if (!present(store)) return [];
  return store.all(`SELECT number, campaign_id, task_id FROM work_items WHERE kind = 'task' AND author_kind = 'supervisor' AND state = 'open'
    AND campaign_id IS NOT NULL AND task_id IS NOT NULL ${campaignId === null ? '' : 'AND campaign_id = ?'}
    AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?) ORDER BY number`, ...(campaignId === null ? [] : [campaignId]), `${FOLLOW_UP}:${NOT_DONE}`);
}

/**
 * A step ended as not done whose head reached the base after all, merged outside AIWorks: its open not-done follow-up is
 * closed with one comment naming the head and the base commit it was found in. Idempotent: a closed item is left alone and
 * a repeated call records no second comment. Returns whether the item was closed now.
 */
export function settleMergedNotDone(store, { number, sha, baseBranch, baseSha, now }) {
  return store.tx(() => {
    if (item(store, number)?.state !== 'open') return false;
    addComment(store, { number, idempotencyKey: `merged:${sha}`, authorKind: 'supervisor', now,
      body: `Settled: this step's head \`${sha}\` was found in ${baseBranch} at \`${baseSha}\`; it was merged outside AIWorks. Check the base before planning any of it again.` });
    setItemState(store, { number, state: 'closed', now });
    return true;
  });
}

/**
 * A follow-up item not tied to a campaign step (#144): one per `key`, so a repeated report records nothing twice. Null
 * when this installation has no work list. Not for the owner: AIWorks plans it like any other work item.
 */
export function standingFollowUp(store, { key, title, body, now }) {
  if (!present(store)) return null;
  const label = `${FOLLOW_UP}:${String(key).slice(0, MAX_LABEL - FOLLOW_UP.length - 1)}`;
  const found = store.get("SELECT number FROM work_items WHERE kind = 'task' AND author_kind = 'supervisor' AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?) LIMIT 1", label);
  return found ? item(store, found.number) : createItem(store, { kind: 'task', title, body, labels: [FOLLOW_UP, label], authorKind: 'supervisor', now });
}

export const PRODUCT_DEFECT = 'product-defect';

/**
 * A product defect an independent verifier found outside its task's write scope (owner decision "independent failure
 * analyst", routing 2): one open `finding` item per `key` across every campaign, linked to the campaign, task and exact
 * SHA that first reported it. A later report from another campaign, task or SHA adds one comment to that open item
 * (idempotent by its links), never a second item; once it is closed, a new report opens a new item. Text that looks like a credential is never stored: the item is then recorded with
 * `fallbackTitle` and `fallback`. Returns { item, created }; null when this installation has no work list.
 */
export function productDefectItem(store, { key, title, body, fallbackTitle, fallback, campaignId, taskId, verifiedSha, now }) {
  if (!present(store)) return null;
  const label = `${PRODUCT_DEFECT}:${String(key).slice(0, MAX_LABEL - PRODUCT_DEFECT.length - 1)}`;
  return store.tx(() => {
    // Only an open item absorbs a report: once its item is closed, the defect seen again is new work and gets a new item.
    const found = store.get("SELECT number, campaign_id, task_id, verified_sha FROM work_items WHERE kind = 'finding' AND author_kind = 'supervisor' AND state = 'open' AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?) ORDER BY number LIMIT 1", label);
    if (found) {
      if (found.campaign_id !== campaignId || found.task_id !== taskId || found.verified_sha !== verifiedSha) {
        addComment(store, { number: found.number, idempotencyKey: `${PRODUCT_DEFECT}:${campaignId}:${taskId}:${verifiedSha}`, authorKind: 'supervisor', now,
          body: `Reported again by the independent verifier of ${campaignId}/${taskId} at \`${verifiedSha}\`.` });
      }
      return { item: item(store, found.number), created: false };
    }
    const links = { campaignId, taskId, verifiedSha }, labels = [PRODUCT_DEFECT, label];
    try {
      return { item: createItem(store, { kind: 'finding', title, body, labels, links, authorKind: 'supervisor', now }), created: true };
    } catch (error) {
      if (error?.code !== 'WORK_ITEM_SECRET' && error?.code !== 'WORK_ITEM_TOO_LARGE') throw error;
      return { item: createItem(store, { kind: 'finding', title: fallbackTitle, body: fallback, labels, links, authorKind: 'supervisor', now }), created: true };
    }
  });
}

/**
 * The work item a declaration names as its owner authorization (`aiworks-work:<n>`), checked: null when the reference
 * is another form. It admits only AIWorks's own repository with local main trusted, and only an open item the owner wrote
 * (never the supervisor or the import) that is linked to this very campaign, so it cannot admit unrelated work.
 * Refusals are WorkListError with a WORK_AUTHORIZATION_* or WORK_ITEM_NOT_FOUND code.
 */
export function workAuthorization(store, declaration, { selfHosting }) {
  const number = Number(WORK_REFERENCE.exec(String(declaration?.authorization?.reference ?? ''))?.[1] ?? 0);
  if (!number) return null;
  const repository = declaration.target?.repository;
  if (!trustsLocalMain(selfHosting, repository)) {
    refuse('WORK_AUTHORIZATION_UNTRUSTED', `aiworks-work:${number} authorizes only AIWorks's own repository with local main trusted, not ${repository}`);
  }
  const found = item(store, number);
  if (!found) refuse('WORK_ITEM_NOT_FOUND', `no work item #${number}`);
  if (found.author_kind !== 'owner') refuse('WORK_AUTHORIZATION_NOT_OWNER', `work item #${number} was not written by the owner`);
  if (found.state !== 'open') refuse('WORK_AUTHORIZATION_CLOSED', `work item #${number} is closed`);
  if (found.campaign_id !== declaration.campaignId) {
    refuse('WORK_AUTHORIZATION_UNRELATED', `work item #${number} authorizes ${found.campaign_id ? `campaign ${found.campaign_id}` : 'no campaign'}, not ${declaration.campaignId}`);
  }
  return found;
}
