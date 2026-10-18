// Private approved declarations (docs/design/WORK_ENVELOPE.md section 5, slice E9; plan STA13). The owner's approved
// declaration and its approval are kept in the installation's own store, never in source Git, and registered from there
// exactly once. Restart and Resume read the stored campaign as before. Nothing here opens a branch, a pull request or an
// upload: there is no publication path for a declaration.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { CampaignError, campaignStatus } from './api.mjs';
import { approvedStart, checkApproval } from './approvals.mjs';
import { authorityDigest, canonicalJson, validateDeclaration } from './campaign.mjs';

// Created on the first persisted approval, because slice E9 (STA13) does not own store.mjs. It is additive: a store that
// never persisted a declaration has no table and behaves exactly as before.
const DDL = `CREATE TABLE IF NOT EXISTS approved_declarations (
  campaign_id TEXT NOT NULL, authority_digest TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE,
  declaration_text TEXT NOT NULL, approval_text TEXT NOT NULL, persisted_at INTEGER NOT NULL, registered_at INTEGER,
  PRIMARY KEY (campaign_id, authority_digest))`;
const hasTable = (store) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'approved_declarations'"));
const short = (digest) => String(digest).slice(0, 12);

/**
 * Campaign data never enters source Git: the store file (and its WAL files) must be outside every Git work tree, or
 * ignored by it. A store Git would track is refused before anything private is written (PRIVATE_STORE_NOT_IGNORED).
 */
export function assertPrivateStore(store) {
  const path = store.identity?.path;
  if (!path || path === ':memory:') return;
  const git = (...args) => spawnSync('git', args, { cwd: dirname(path), encoding: 'utf8', windowsHide: true });
  const top = git('rev-parse', '--show-toplevel');
  if (top.error) throw new CampaignError('PRIVATE_STORE_UNCHECKED', `cannot check that the store is outside source Git (${top.error.code ?? top.error.name})`);
  if (top.status !== 0) return; // not inside a work tree
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    const ignored = git('check-ignore', '-q', '--', file);
    if (ignored.status === 1) {
      throw new CampaignError('PRIVATE_STORE_NOT_IGNORED', 'the supervisor store is inside a Git work tree that does not ignore it; approved declarations are private and never enter source Git. Use a data directory outside the checkout, or one it ignores');
    }
    if (ignored.status !== 0) throw new CampaignError('PRIVATE_STORE_UNCHECKED', `cannot check that the store is ignored by Git (exit ${ignored.status})`);
  }
}

/** The stored row, re-checked: its declaration's authorityDigest must equal both the row's and the approval's digest. */
function verified(row) {
  let declaration;
  let approval;
  try {
    declaration = JSON.parse(row.declaration_text);
    approval = JSON.parse(row.approval_text);
  } catch {
    // Never echo private contents or parser snippets.
    throw new CampaignError('DECLARATION_DIFFERS_FROM_APPROVAL', `the stored declaration of ${row.campaign_id} cannot be read; nothing was started. Persist the approved plan again`);
  }
  const actual = authorityDigest(declaration);
  if (actual !== row.authority_digest || approval?.authorityDigest !== row.authority_digest || declaration?.campaignId !== row.campaign_id) {
    throw new CampaignError('DECLARATION_DIFFERS_FROM_APPROVAL',
      `the stored declaration of ${row.campaign_id} has authority digest ${short(actual)}, not the approved ${short(row.authority_digest)}; nothing was started. Persist the approved plan again`);
  }
  return { declaration, approval };
}

const view = (row) => ({ campaignId: row.campaign_id, authorityDigest: row.authority_digest, approvalId: row.approval_id,
  persistedAt: new Date(row.persisted_at).toISOString(), registeredAt: row.registered_at === null ? null : new Date(row.registered_at).toISOString() });

/** The persisted approved declarations of one campaign, oldest first, without their contents. Read-only. */
export function approvedDeclarations(store, campaignId) {
  if (!hasTable(store)) return [];
  return store.all('SELECT * FROM approved_declarations WHERE campaign_id = ? ORDER BY persisted_at, rowid', campaignId).map(view);
}

/** The latest persisted approved declaration of a campaign, verified against its approval digest. */
export function approvedDeclaration(store, campaignId) {
  const row = hasTable(store) ? store.get('SELECT * FROM approved_declarations WHERE campaign_id = ? ORDER BY persisted_at DESC, rowid DESC LIMIT 1', campaignId) : null;
  if (!row) throw new CampaignError('APPROVED_DECLARATION_NOT_FOUND', `no approved declaration is persisted for campaign ${campaignId}; persist it with approve <declaration.json> --approval <approval.json>`);
  return { ...verified(row), ...view(row) };
}

/**
 * Keep the owner's approved declaration privately, bound to its approval. The approval is checked exactly as for a start
 * (approvals.mjs): one changed byte is DECLARATION_DIFFERS_FROM_APPROVAL and a revoked approval is refused. Persisting the
 * same approval again changes nothing. Persisting registers nothing and starts nothing.
 */
export function persistApproved(store, declaration, approval, { now = Date.now() } = {}) {
  if (approval === null || approval === undefined) throw new CampaignError('APPROVAL_REQUIRED', 'an approved declaration is persisted only with its private approval');
  validateDeclaration(declaration);
  assertPrivateStore(store);
  store.db.exec(DDL);
  return store.tx(() => {
    const bound = checkApproval(store, declaration, approval);
    const sameId = store.get('SELECT * FROM approved_declarations WHERE approval_id = ?', bound.approvalId);
    if (sameId && (sameId.campaign_id !== bound.campaignId || sameId.authority_digest !== bound.authorityDigest)) {
      throw new CampaignError('APPROVAL_INVALID', `approval id ${bound.approvalId} is already persisted for a different approval; an approval id names one approval`);
    }
    const added = store.run(`INSERT OR IGNORE INTO approved_declarations (campaign_id, authority_digest, approval_id, declaration_text, approval_text, persisted_at)
      VALUES (?, ?, ?, ?, ?, ?)`, bound.campaignId, bound.authorityDigest, bound.approvalId, canonicalJson(declaration), canonicalJson(bound), now);
    if (added.changes) store.journal(bound.campaignId, 'declaration-persisted', { approvalId: bound.approvalId, authorityDigest: bound.authorityDigest }, now);
    const row = store.get('SELECT * FROM approved_declarations WHERE campaign_id = ? AND authority_digest = ?', bound.campaignId, bound.authorityDigest);
    return { ...view(row), persisted: Boolean(added.changes) };
  });
}

/**
 * Register the campaign from its latest persisted approved declaration, once. The stored bytes are re-checked against
 * the approval first. A campaign already registered under this authority digest is left as it is (a paused campaign
 * stays paused: Resume is a separate owner act), so a retry, a second caller or a restart registers nothing twice.
 * A newer approved declaration (authorization.version + 1) amends through the existing start rules.
 */
export function registerApproved(store, campaignId, { now = Date.now() } = {}) {
  return store.tx(() => {
    const { declaration, approval, authorityDigest: digest } = approvedDeclaration(store, campaignId);
    const existing = store.campaign(campaignId);
    const already = Boolean(existing) && authorityDigest(existing.declaration) === digest;
    if (already) checkApproval(store, declaration, approval);
    else approvedStart(store, declaration, approval, { now });
    store.run('UPDATE approved_declarations SET registered_at = ? WHERE campaign_id = ? AND authority_digest = ? AND registered_at IS NULL', now, campaignId, digest);
    return { registered: !already, authorityDigest: digest, approvalId: approval.approvalId, ...campaignStatus(store, campaignId, now) };
  });
}
