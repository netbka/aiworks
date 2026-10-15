// Private envelope approvals (docs/design/WORK_ENVELOPE.md section 5, slice E7). An approved plan starts only when its
// declaration's authorityDigest equals the owner's private approval and the runtime code is merged (provenance.mjs).
// Approval records are private installation data: the owner keeps the file outside source Git, and the store keeps
// which approval each campaign started under. Nothing here publishes a declaration or an approval.
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { CampaignError, campaignCancel, campaignStart } from './api.mjs';
import { authorityDigest } from './campaign.mjs';

export const APPROVAL_SCHEMA = 'aiworks-envelope-approval/1';
const validate = new Ajv2020({ allErrors: true })
  .compile(JSON.parse(readFileSync(new URL('../../schemas/envelope-approval.schema.json', import.meta.url), 'utf8')));

// The table is created here, on the first approved start, because slice E7 (STA11) does not own store.mjs. It is
// additive: a store that never saw an approval has no table and behaves exactly as before.
const APPROVALS_DDL = `CREATE TABLE IF NOT EXISTS envelope_approvals (
  approval_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, authority_digest TEXT NOT NULL, approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL, recorded_at INTEGER NOT NULL, revoked_at INTEGER, revoked_reason TEXT)`;
const hasApprovals = (store) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'envelope_approvals'"));
const short = (digest) => String(digest).slice(0, 12);

/**
 * Off by default. With config.json `"approvals": { "required": true }`, a new version 2 registration needs a private
 * approval. Without it, an approval binds only the campaigns started under one, and version 1 is never affected.
 */
export const approvalRequired = (config) => config?.approvals?.required === true;

/** The shape of a private approval record; throws APPROVAL_INVALID without echoing its contents. */
export function validateApproval(record) {
  if (!validate(record) || Number.isNaN(Date.parse(record.approvedAt)) || (record.revokedAt !== undefined && Number.isNaN(Date.parse(record.revokedAt)))) {
    const fields = [...new Set((validate.errors ?? []).map((error) => error.instancePath || error.params?.missingProperty || error.params?.additionalProperty || '/'))];
    throw new CampaignError('APPROVAL_INVALID', `The approval is not a valid ${APPROVAL_SCHEMA} record${fields.length ? ` (check ${fields.slice(0, 5).join(', ')})` : ' (check its dates)'}.`);
  }
  return record;
}

/** The approvals recorded for one campaign, oldest first. Read-only; a store without approvals has none. */
export function campaignApprovals(store, campaignId) {
  if (!hasApprovals(store)) return [];
  return store.all('SELECT * FROM envelope_approvals WHERE campaign_id = ? ORDER BY recorded_at, approval_id', campaignId)
    .map((row) => ({ approvalId: row.approval_id, authorityDigest: row.authority_digest, approvedBy: row.approved_by, approvedAt: row.approved_at,
      recordedAt: new Date(row.recorded_at).toISOString(), revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(), revokedReason: row.revoked_reason }));
}

/**
 * Whether this declaration may start under this approval (null when none was given). Refuses, in order: a missing
 * approval for a campaign that started under one (or for a new version 2 registration when `required`); an invalid
 * record; an approval for another campaign; a revoked approval; an approval id reused for another binding; and any
 * declaration whose authorityDigest differs from the approved one, even by one byte (DECLARATION_DIFFERS_FROM_APPROVAL).
 */
export function checkApproval(store, declaration, approval, { required = false } = {}) {
  const campaignId = declaration?.campaignId;
  if (approval === null || approval === undefined) {
    if (campaignApprovals(store, campaignId).length) {
      throw new CampaignError('APPROVAL_REQUIRED', `campaign ${campaignId} started under a private approval; start it again with --approval <file>`);
    }
    if (required && declaration?.version === 2 && !store.campaign(campaignId)) {
      throw new CampaignError('APPROVAL_REQUIRED', `a new version 2 campaign starts only under the owner's private approval; start it with --approval <file>`);
    }
    return null;
  }
  validateApproval(approval);
  if (approval.campaignId !== campaignId) {
    throw new CampaignError('APPROVAL_CAMPAIGN_MISMATCH', `the approval is for campaign ${approval.campaignId}, not ${campaignId}`);
  }
  if (approval.revokedAt !== undefined) throw new CampaignError('APPROVAL_REVOKED', `approval ${approval.approvalId} was revoked at ${approval.revokedAt}`);
  const stored = hasApprovals(store) ? store.get('SELECT * FROM envelope_approvals WHERE approval_id = ?', approval.approvalId) : null;
  if (stored?.revoked_at !== null && stored?.revoked_at !== undefined) {
    throw new CampaignError('APPROVAL_REVOKED', `approval ${approval.approvalId} was revoked at ${new Date(stored.revoked_at).toISOString()}`);
  }
  if (stored && (stored.campaign_id !== approval.campaignId || stored.authority_digest !== approval.authorityDigest)) {
    throw new CampaignError('APPROVAL_INVALID', `approval id ${approval.approvalId} is already recorded for a different approval; an approval id names one approval`);
  }
  const actual = authorityDigest(declaration);
  if (actual !== approval.authorityDigest) {
    throw new CampaignError('DECLARATION_DIFFERS_FROM_APPROVAL',
      `the declaration's authority digest ${short(actual)} differs from the approved ${short(approval.authorityDigest)}; nothing was started. Approve the changed plan again, or start the plan exactly as approved`);
  }
  return approval;
}

/**
 * Register, amend or resume exactly as campaignStart does, but only under a matching private approval. The check, the
 * start and the approval record share one transaction: a refused start records nothing and starts nothing.
 */
export function approvedStart(store, declaration, approval, { required = false, now = Date.now() } = {}) {
  if (approval !== null && approval !== undefined) store.db.exec(APPROVALS_DDL);
  return store.tx(() => {
    const bound = checkApproval(store, declaration, approval, { required });
    const status = campaignStart(store, declaration, now);
    if (bound) {
      const added = store.run(`INSERT OR IGNORE INTO envelope_approvals (approval_id, campaign_id, authority_digest, approved_by, approved_at, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)`, bound.approvalId, bound.campaignId, bound.authorityDigest, bound.approvedBy, bound.approvedAt, now);
      if (added.changes) store.journal(bound.campaignId, 'approval-bound', { approvalId: bound.approvalId, authorityDigest: bound.authorityDigest }, now);
    }
    return status;
  });
}

/**
 * The owner withdraws every recorded approval of a campaign. Nothing starts under them again: a registered or paused
 * campaign is cancelled (cancel, unlike pause, cannot be resumed from the dashboard), and `start` refuses a revoked
 * approval. A new approval of new work uses a new campaign id.
 */
export function revokeApprovals(store, campaignId, { reason = null, now = Date.now() } = {}) {
  if (!campaignApprovals(store, campaignId).length) throw new CampaignError('APPROVAL_NOT_FOUND', `no private approval is recorded for campaign ${campaignId}`);
  return store.tx(() => {
    const revoked = Number(store.run('UPDATE envelope_approvals SET revoked_at = ?, revoked_reason = ? WHERE campaign_id = ? AND revoked_at IS NULL',
      now, reason, campaignId).changes);
    store.journal(campaignId, 'approval-revoked', { revoked, reason }, now);
    const campaign = store.campaign(campaignId);
    if (campaign && ['registered', 'paused'].includes(campaign.control)) campaignCancel(store, campaignId, reason ?? 'private approval revoked', now);
    return { campaignId, revoked, control: store.campaign(campaignId)?.control ?? null, approvals: campaignApprovals(store, campaignId) };
  });
}
