// Campaign-API token management: one general, reusable capability for every AIWorks-registered project, not a
// one-off for a single external project. `config.json` `campaignApi` (src/supervisor/remote-campaigns.mjs,
// docs/SUPERVISOR.md section 16) authenticates the whole local `POST /api/campaigns` / `GET /api/campaigns/:id/status`
// surface with a single bearer token resolved by reference from the operator's secret store; before this module the
// only way to create, rotate or point that reference at a value was to edit the Windows Credential Manager and
// config.json by hand. This module gives every registered project (`registry/projects/<id>.json` in the governance
// checkout) the same CLI action: `cli.mjs campaign-token create|rotate <projectId>`.
//
// The reference is never invented by the caller: it is always `aiworks-campaign-api:<projectId>` (campaignTokenRef
// below), so the credential store's own listing already says which project a token belongs to, and no two callers can
// collide on a name. The value is a fresh crypto.randomBytes(32).toString('base64url') (256 bits), written straight to
// the store (release/credential.mjs windowsCredentialStore / commandCredentialStore: the same kind of store the
// release credential already reads) and never returned, logged, journalled or printed by this module or its caller --
// only the fact that it now exists under that reference. Only the store's own generic `set` and `has` are used here,
// never the release credential's own reserved reader (release/credential.mjs; tests/supervisor/release-boundary.test.mjs
// keep that one call to the release runner's own short-lived process for a deploy-grade secret): this token is a
// different, unrelated secret.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CampaignError } from './api.mjs';
import { requireGovernanceRoot } from './governance.mjs';
import { writeAtomic } from './proc.mjs';
import { credentialStoreFrom } from './release/credential.mjs';

/** Every campaign-API token this module manages lives under this credential-store prefix. */
export const CAMPAIGN_TOKEN_PREFIX = 'aiworks-campaign-api';

/** A registry contract id's shape (schemas/project-contract.schema.json `id`): lowercase, digits, dash or underscore,
 * bounded so the composed reference always satisfies release/credential.mjs validCredentialRef's own 128-character cap. */
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) {
    throw new CampaignError('PROJECT_ID_INVALID', 'a project id is lowercase letters, digits, dash or underscore, exactly like its registry/projects/<id>.json file name');
  }
}

/** The one standard credential-store reference for a project's campaign-API token: `aiworks-campaign-api:<projectId>`. */
export function campaignTokenRef(projectId) {
  assertProjectId(projectId);
  return `${CAMPAIGN_TOKEN_PREFIX}:${projectId}`;
}

/**
 * Confirms `registry/projects/<projectId>.json` exists in the governance checkout -- the same registration a new
 * campaign already needs (campaign.mjs assertRegisteredTarget), checked here by id instead of by declared repository.
 * Throws GOVERNANCE_ROOT_REQUIRED / GOVERNANCE_ROOT_INVALID (governance.mjs) for a missing or invalid checkout, or
 * PROJECT_NOT_REGISTERED when the file is absent. Reads only its existence, never its content.
 */
export function assertRegisteredProjectId(projectId, governanceRoot) {
  assertProjectId(projectId);
  const root = requireGovernanceRoot(governanceRoot);
  const file = join(root, 'registry', 'projects', `${projectId}.json`);
  if (!existsSync(file)) {
    throw new CampaignError('PROJECT_NOT_REGISTERED', `${projectId} is not a registered project: no registry/projects/${projectId}.json in the governance checkout`);
  }
}

/** <dataDir>/config.json, or {} when absent or malformed. */
const readConfig = (dataDir) => { try { return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { return {}; } };

/**
 * Point `config.json` `campaignApi` at `ref`: `{ enabled: true, tokenRef: ref }`, plus `credentialStore` when the
 * caller used a non-default one. This is the one field remote-campaigns.mjs `campaignApiSettings` reads; nothing
 * about the project id is stored here; config.json never holds a secret value (AGENTS.md: "configuration holds
 * executable paths and repository paths, never secret values").
 */
export function applyCampaignApiConfig(dataDir, ref, { credentialStoreSpec } = {}) {
  const configFile = join(dataDir, 'config.json');
  const config = readConfig(dataDir);
  config.campaignApi = { enabled: true, tokenRef: ref, ...(credentialStoreSpec ? { credentialStore: credentialStoreSpec } : {}) };
  writeAtomic(configFile, JSON.stringify(config, null, 2));
  return config.campaignApi;
}

/**
 * Create or rotate a registered project's campaign-API token. `rotate: false` (create) refuses to overwrite a value
 * already stored under the reference (TOKEN_ALREADY_EXISTS: use rotate instead); `rotate: true` refuses when nothing
 * is there yet to rotate (TOKEN_NOT_FOUND: use create first). Either way the fresh random value replaces or creates
 * the store entry and `config.json` `campaignApi` is pointed at it, unless `applyConfig: false` -- for a caller that
 * would rather print the exact patch than touch config.json itself. Returns `{ projectId, ref, rotated, config }`,
 * `config` being the resulting `campaignApi` setting (or null when `applyConfig: false`); the token value is never
 * part of the return.
 */
export function issueCampaignToken(projectId, { governanceRoot, dataDir, rotate = false, credentialStoreSpec, applyConfig = true, randomToken = () => randomBytes(32).toString('base64url') } = {}) {
  assertRegisteredProjectId(projectId, governanceRoot);
  const ref = campaignTokenRef(projectId);
  const store = credentialStoreFrom(credentialStoreSpec);
  let existed;
  try { existed = store.has(ref) === true; }
  catch (error) { throw new CampaignError('CREDENTIAL_STORE_UNREADABLE', `cannot tell whether ${ref} already exists: ${error.message}`); }
  if (existed && !rotate) throw new CampaignError('TOKEN_ALREADY_EXISTS', `${ref} already exists; run campaign-token rotate ${projectId} to replace it`);
  if (!existed && rotate) throw new CampaignError('TOKEN_NOT_FOUND', `${ref} does not exist yet; run campaign-token create ${projectId} first`);
  store.set(ref, randomToken());
  const config = applyConfig ? applyCampaignApiConfig(dataDir, ref, { credentialStoreSpec }) : null;
  return { projectId, ref, rotated: existed, config };
}
