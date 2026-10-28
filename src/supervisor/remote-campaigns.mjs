// The optional external campaign API (off by default; docs/SUPERVISOR.md section 16): `POST /api/campaigns` and
// `GET /api/campaigns/:id/status` on the dashboard's own HTTP server (src/dashboard/server.mjs), for an external system
// — a change-request tracker, for example — that registers a campaign and reads its status the same way the CLI and the
// owner's dashboard already do, over HTTP instead of a local process or a browser session. It widens nothing: the same
// declaration shape (campaign.mjs validateDeclaration), the same AW-005 merged-code gate against the same trusted main
// (provenance.mjs revisionNotMerged with runtimeTrust), the same registered-project gate for a campaign not yet stored
// (campaign.mjs assertRegisteredTarget), the same optional owner approval requirement (approvals.mjs).
// `registerRemoteCampaign` is exactly `cli.mjs start` with no `--approval`, given an already-parsed declaration instead
// of a private file. A token stored under a project's standard reference (`aiworks-campaign-api:<projectId>`,
// campaign-token.mjs) reaches only that project's campaigns.
//
// Authentication is a static bearer token, resolved by reference from the operator's own secret store
// (token-store.mjs): config.json never holds the token value itself (AGENTS.md: configuration holds paths, never secret
// values). This token is never the dashboard's own per-process CSRF secret (server.mjs), and the CSRF secret is never
// accepted here: the browser surface and this surface share no secret.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CampaignError, campaignStatus } from './api.mjs';
import { CODE_ROOT, revisionNotMerged, runtimeTrust } from './provenance.mjs';
import { assertRegisteredTarget } from './campaign.mjs';
import { approvalRequired, approvedStart } from './approvals.mjs';
import { requireGovernanceRoot } from './governance.mjs';
import { CAMPAIGN_TOKEN_PREFIX, PROJECT_ID } from './campaign-token.mjs';
import { readToken, tokenStoreFrom, validTokenRef } from './token-store.mjs';

const validStoreSpec = (store) => store === undefined || (store && typeof store === 'object' && !Array.isArray(store) &&
  (store.kind === 'windows' || (store.kind === 'command' && Array.isArray(store.command) && store.command.length > 0 &&
    store.command.every((part) => typeof part === 'string' && part))));

/**
 * config.json `campaignApi`: `{ enabled: true, tokenRef: "<name>", credentialStore?: { kind: "windows" } | { kind:
 * "command", command: [...] } }`. Off by default; absent, malformed, an unknown key, `enabled` not exactly `true`, an
 * invalid `tokenRef` or store all answer `{ enabled: false }` — never a partial or best-effort enablement. Without
 * `credentialStore` the Windows Credential Manager is used. `projectId` is set when `tokenRef` is a project's standard
 * reference: the token then reaches that project's campaigns only.
 */
export function campaignApiSettings(config) {
  const raw = config?.campaignApi;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.enabled !== true || !validTokenRef(raw.tokenRef)) return { enabled: false };
  if (Object.keys(raw).some((key) => !['enabled', 'tokenRef', 'credentialStore'].includes(key))) return { enabled: false };
  if (!validStoreSpec(raw.credentialStore)) return { enabled: false };
  const prefix = `${CAMPAIGN_TOKEN_PREFIX}:`;
  const named = raw.tokenRef.startsWith(prefix) ? raw.tokenRef.slice(prefix.length) : null;
  if (named !== null && !PROJECT_ID.test(named)) return { enabled: false };
  return { enabled: true, tokenRef: raw.tokenRef, credentialStore: raw.credentialStore ?? { kind: 'windows' }, projectId: named };
}

const digest = (value) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Whether `authorization` (the request's Authorization header) is `Bearer <token>` for the configured reference's
 * current value. The value is resolved fresh from the store on every call and only when a bearer token was supplied;
 * it is compared as fixed-length digests in constant time and never returned, logged or cached. A store that cannot
 * tell, an unresolved reference or an empty value refuse exactly like a wrong token: this never opens access.
 */
export function campaignApiAuthorized(settings, authorization, { store = null } = {}) {
  if (!settings?.enabled) return false;
  const match = /^Bearer ([\x21-\x7e]+)$/.exec(typeof authorization === 'string' ? authorization : '');
  if (!match) return false;
  let expected = null;
  try { expected = readToken(store ?? tokenStoreFrom(settings.credentialStore), settings.tokenRef); } catch { return false; }
  if (!expected) return false;
  return timingSafeEqual(digest(match[1]), digest(expected));
}

const remoteFail = (status, code, message) => Object.assign(new Error(message), { status, code });

/**
 * The one repository a project-named token reaches (lower case), or null for a token under any other reference, which
 * reaches what `cli.mjs start` and `status` reach. The repository is read from the project's registry entry in the
 * governance checkout; a missing checkout or entry refuses.
 */
export function campaignApiScope(settings, governanceRoot) {
  if (!settings?.enabled || settings.projectId === null || settings.projectId === undefined) return null;
  let root;
  try { root = requireGovernanceRoot(governanceRoot); }
  catch (error) { throw remoteFail(503, error.code ?? 'GOVERNANCE_ROOT_INVALID', error.message); }
  let repository = null;
  try { repository = JSON.parse(readFileSync(join(root, 'registry', 'projects', `${settings.projectId}.json`), 'utf8'))?.repository?.github; } catch { repository = null; }
  if (typeof repository !== 'string' || !repository) {
    throw remoteFail(403, 'PROJECT_NOT_REGISTERED', `${settings.projectId} is not a registered project in the governance checkout`);
  }
  return repository.toLowerCase();
}

const repositoryOf = (declaration) => String(declaration?.target?.repository ?? '').toLowerCase();
const storedRepository = (row) => { try { return repositoryOf(JSON.parse(row.declaration)); } catch { return ''; } };

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

/**
 * Register, amend or resume a campaign exactly as `cli.mjs start <file>` does with no `--approval`: `declaration` is the
 * already-parsed JSON body (the same shape `src/supervisor/campaign.mjs` validates from a file). `config` is the data
 * directory's config.json: its trusted main (AW-005 selfHosting) and the optional owner approval requirement. `scope`
 * (campaignApiScope) limits a project-named token to its own repository, for the declaration and for any campaign
 * already stored under that id. Returns `{ status, created }`: `status` is the same shape `cli.mjs status` prints
 * (api.mjs campaignStatus); `created` is true only for a brand-new campaign id.
 */
export function registerRemoteCampaign(store, declaration, { provenanceRoot = CODE_ROOT, governanceRoot, config = {}, scope = null, now = Date.now() } = {}) {
  const notMerged = revisionNotMerged({ root: provenanceRoot ?? CODE_ROOT, trust: runtimeTrust(config, store) });
  if (notMerged) throw remoteFail(503, 'RUNTIME_NOT_MERGED', notMerged);
  const campaignId = typeof declaration?.campaignId === 'string' ? declaration.campaignId : null;
  const existing = campaignId === null ? null : store.campaign(campaignId);
  if (scope !== null && (repositoryOf(declaration) !== scope || (existing && storedRepository(existing) !== scope))) {
    throw remoteFail(403, 'TOKEN_OUT_OF_SCOPE', 'this campaign API token is for another project');
  }
  // Only a new registration is gated on the registry; resuming or amending a stored campaign is unaffected (cli.mjs start).
  if (!existing) {
    try { assertRegisteredTarget(declaration, governanceRoot); }
    catch (error) { throw remoteFail(STATUS_BY_CODE[error.code] ?? 403, error.code ?? 'NOT_REGISTERED', error.message); }
  }
  try {
    const status = approvedStart(store, declaration, null, { required: approvalRequired(config), now });
    return { status, created: !existing && campaignId !== null };
  } catch (error) {
    if (error instanceof CampaignError) throw remoteFail(STATUS_BY_CODE[error.code] ?? 400, error.code, error.message);
    if (error instanceof TypeError) throw remoteFail(400, 'INVALID_DECLARATION', error.message);
    throw error;
  }
}

/**
 * The reading `cli.mjs status <id>` prints, for a campaign `scope` reaches. A campaign of another project answers
 * exactly like one that does not exist.
 */
export function remoteCampaignStatus(store, id, { scope = null, config = {}, releaseStop = false, now = Date.now() } = {}) {
  const row = store.campaign(id);
  if (!row || (scope !== null && storedRepository(row) !== scope)) throw remoteFail(404, 'CAMPAIGN_NOT_FOUND', `campaign ${id} is not registered`);
  return campaignStatus(store, id, now, { config, selfHostingConfig: config, releaseStop });
}
