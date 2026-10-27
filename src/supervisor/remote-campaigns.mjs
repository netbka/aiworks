// The optional external campaign API (off by default; docs/SUPERVISOR.md section 16): `POST /api/campaigns`,
// `GET /api/campaigns/:id/status` and `GET /api/campaigns/:id/report` served by the dashboard process
// (src/dashboard/server.mjs, on its own port or on `campaignApi.port`), for an external system
// — a change-request tracker, for example — that registers a campaign and reads its status the same way the CLI and the
// owner's dashboard already do, over HTTP instead of a local process or a browser session. It widens nothing: the same
// declaration shape (campaign.mjs validateDeclaration), the same AW-005 merged-code gate (provenance.mjs
// revisionNotMerged), the same registered-project gate for a new campaign id (campaign.mjs assertRegisteredTarget), the
// same optional owner approval requirement (approvals.mjs). `registerRemoteCampaign` is exactly `cli.mjs start` with no
// `--approval`, given an already-parsed declaration instead of a private file.
//
// Authentication is a static bearer token, resolved by reference from the operator's own secret store (the same kind of
// store the release credential already reads, release/credential.mjs): config.json never holds the token value itself
// (AGENTS.md: configuration holds paths, never secret values). This token is never the dashboard's own per-process CSRF
// secret (server.mjs), and the CSRF secret is never accepted here: the browser surface and this surface share no secret.
import { createHash } from 'node:crypto';
import { CampaignError } from './api.mjs';
import { specsOf } from './plan.mjs';
import { CODE_ROOT, revisionNotMerged } from './provenance.mjs';
import { assertRegisteredTarget } from './campaign.mjs';
import { approvalRequired, approvedStart } from './approvals.mjs';
// Only the generic store builder and reference-format check are reused here, never the release credential's own
// reader function (release/credential.mjs; tests/supervisor/release-boundary.test.mjs keep that one name to the
// release runner's own short-lived process, for a deploy-grade secret). This token is a different, unrelated secret
// reached through the same kind of store, so its value is read with the store's own `get` instead.
import { credentialStoreFrom, validCredentialRef } from './release/credential.mjs';

/**
 * config.json `campaignApi`: `{ enabled: true, tokenRef: "<name>", credentialStore?: { kind: "windows" } | { kind:
 * "command", command: [...] } }`. Off by default; absent, malformed, `enabled` not exactly `true`, or an invalid
 * `tokenRef` all answer `{ enabled: false }` — never a partial or best-effort enablement. Without `credentialStore` the
 * Windows Credential Manager is used, exactly as the release credential's own default (release/credential.mjs).
 */
export function campaignApiSettings(config) {
  const raw = config?.campaignApi;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.enabled !== true || !validCredentialRef(raw.tokenRef)) return { enabled: false };
  if (Object.keys(raw).some((key) => !['enabled', 'tokenRef', 'credentialStore', 'port'].includes(key))) return { enabled: false };
  const store = raw.credentialStore;
  if (store !== undefined && (!store || typeof store !== 'object' || Array.isArray(store) || !['windows', 'command'].includes(store.kind))) {
    return { enabled: false };
  }
  if (raw.port !== undefined && !(Number.isSafeInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535)) return { enabled: false };
  return { enabled: true, tokenRef: raw.tokenRef, credentialStore: store ?? { kind: 'windows' }, port: raw.port ?? null };
}

/**
 * The verified reports of a campaign's report tasks, for `GET /api/campaigns/:id/report`. A task's report is returned
 * only once independent verification accepted it (state `verified` or `done` with a verified revision); before that
 * the entry has `report: null`, so an implementer's unverified output never leaves this computer through the API.
 * No local path, worker log or verifier evidence is part of the answer. Throws CAMPAIGN_NOT_FOUND like campaignStatus.
 */
export function campaignReports(store, id) {
  const campaign = store.campaign(id);
  if (!campaign) throw new CampaignError('CAMPAIGN_NOT_FOUND', `campaign ${id} is not registered in the selected store`);
  const specs = specsOf(store, id, campaign.declaration);
  const tasks = [];
  for (const row of store.tasks(id)) {
    if (specs.get(row.task_id)?.deliverable !== 'report') continue;
    const verified = ['verified', 'done'].includes(row.state) && /^[0-9a-f]{40}$/.test(row.verified_sha ?? '') && typeof row.result?.report === 'string';
    const report = verified ? row.result.report : null;
    tasks.push({ taskId: row.task_id, state: row.state, verifiedSha: verified ? row.verified_sha : null, report,
      reportSha256: report === null ? null : createHash('sha256').update(report, 'utf8').digest('hex') });
  }
  return { campaignId: id, control: campaign.control, reportPublication: campaign.declaration.reportPublication ?? 'issue', tasks };
}

/**
 * The configured token's current value, or null when the reference does not resolve. Throws when the store cannot tell
 * (release/credential.mjs: "a throw means cannot tell, never absent"), which the caller must treat as refused, never as
 * open access. Called once per request; the value is returned to the caller only, never logged, journalled or stored.
 */
export function resolveCampaignApiToken(settings) {
  if (!settings?.enabled) return null;
  const value = credentialStoreFrom(settings.credentialStore).get(settings.tokenRef);
  return typeof value === 'string' && value.length ? value : null;
}

// Every CampaignError this path can throw, mapped to the HTTP status an external caller should act on. An unmapped
// CampaignError or a validateDeclaration TypeError defaults to 400: the declaration itself needs to change. A
// GovernanceRootError (campaign.mjs assertRegisteredTarget, via governance.mjs) names the operator's own missing or
// invalid governance checkout, never the caller's declaration, so it is 503 like RUNTIME_NOT_MERGED.
const STATUS_BY_CODE = {
  RUNTIME_NOT_MERGED: 503, GOVERNANCE_ROOT_REQUIRED: 503, GOVERNANCE_ROOT_INVALID: 503,
  WORK_ALREADY_ASSIGNED: 409, SCOPE_CONFLICT: 409, EXECUTOR_HANDOVER_REQUIRED: 409, ROUTING_HANDOVER_REQUIRED: 409,
  STALE_AUTHORIZATION: 409, AUTHORIZATION_VERSION_REQUIRED: 409, APPROVAL_REQUIRED: 409,
  APPROVAL_CAMPAIGN_MISMATCH: 409, APPROVAL_REVOKED: 409, DECLARATION_DIFFERS_FROM_APPROVAL: 409,
  PROTECTED_AREA: 403,
};
const remoteFail = (status, code, message) => Object.assign(new Error(message), { status, code });

/**
 * Register, amend or resume a campaign exactly as `cli.mjs start <file>` does with no `--approval`: `declaration` is the
 * already-parsed JSON body (the same shape `src/supervisor/campaign.mjs` validates from a file). Returns
 * `{ status, created }`: `status` is the same shape `cli.mjs status` prints (api.mjs campaignStatus); `created` is true
 * only for a brand-new campaign id (a resend of the same declaration, or an amendment, is `created: false`, exactly as
 * `start` never refuses an identical resend). `config` is the data directory's config.json, for the optional owner
 * approval requirement (`approvals.required`); without it the external caller needs none, exactly as a plain `start`.
 */
export function registerRemoteCampaign(store, declaration, { provenanceRoot = CODE_ROOT, governanceRoot, config = {}, now = Date.now() } = {}) {
  const notMerged = revisionNotMerged({ root: provenanceRoot });
  if (notMerged) throw remoteFail(503, 'RUNTIME_NOT_MERGED', notMerged);
  const campaignId = typeof declaration?.campaignId === 'string' ? declaration.campaignId : null;
  const created = campaignId !== null && !store.campaign(campaignId);
  if (created) {
    try { assertRegisteredTarget(declaration, governanceRoot); }
    catch (error) { throw remoteFail(STATUS_BY_CODE[error.code] ?? 403, error.code ?? 'NOT_REGISTERED', error.message); }
  }
  try {
    const status = approvedStart(store, declaration, null, { required: approvalRequired(config), now });
    return { status, created };
  } catch (error) {
    if (error instanceof CampaignError) throw remoteFail(STATUS_BY_CODE[error.code] ?? 400, error.code, error.message);
    if (error instanceof TypeError) throw remoteFail(400, 'INVALID_DECLARATION', error.message);
    throw error;
  }
}
