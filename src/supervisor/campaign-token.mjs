// Campaign-API token management: one general, reusable capability for every AIWorks-registered project, not a
// one-off for a single external project. `config.json` `campaignApi` (src/supervisor/remote-campaigns.mjs,
// docs/SUPERVISOR.md section 16) authenticates the whole local `POST /api/campaigns` / `GET /api/campaigns/:id/status`
// surface with bearer tokens, one per project, resolved by reference from the operator's secret store; before this module the
// only way to create, rotate or point that reference at a value was to edit the Windows Credential Manager and
// config.json by hand. This module gives every registered project (`registry/projects/<id>.json` in the governance
// checkout) the same CLI action: `cli.mjs campaign-token create|rotate <projectId>`.
//
// The reference is never invented by the caller: it is always `aiworks-campaign-api:<projectId>` (campaignTokenRef
// below), so the credential store's own listing already says which project a token belongs to, and no two callers can
// collide on a name. The value is a fresh crypto.randomBytes(32).toString('base64url') (256 bits), written straight to
// the store (token-store.mjs: the Windows Credential Manager or an operator's helper command) and never returned,
// logged, journalled or printed by this module or its caller -- only the fact that it now exists under that reference.
// Only the store's `has` and `set` are used here; the release credential (release/credential.mjs) is never touched.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CampaignError } from './api.mjs';
import { requireGovernanceRoot } from './governance.mjs';
import { writeAtomic } from './proc.mjs';
import { tokenStoreFrom, validTokenRef } from './token-store.mjs';

/** Every campaign-API token this module manages lives under this credential-store prefix. */
export const CAMPAIGN_TOKEN_PREFIX = 'aiworks-campaign-api';

/** A registry contract id's shape (schemas/project-contract.schema.json `id`): lowercase, digits, dash or underscore,
 * bounded so the composed reference always satisfies token-store.mjs validTokenRef's own 128-character cap. */
export const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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

/** <dataDir>/config.json, or {} when absent. A file that is not a JSON object refuses, so the operator's other settings
 * are never replaced by a fresh file. */
function readConfig(dataDir) {
  const file = join(dataDir, 'config.json');
  if (!existsSync(file)) return {};
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); } catch { config = null; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new CampaignError('CONFIG_INVALID', 'config.json in the data directory is not a JSON object; fix it before creating a campaign API token');
  }
  return config;
}

/**
 * The token references a `campaignApi` setting names: the single `tokenRef` an older installation wrote, the
 * `tokenRefs` list (one reference per project, so several callers work at once), or both, in that order, without
 * repeats. Null when either is present but malformed, or when neither names a reference.
 */
export function configuredTokenRefs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const refs = [];
  if (raw.tokenRef !== undefined) refs.push(raw.tokenRef);
  if (raw.tokenRefs !== undefined) {
    if (!Array.isArray(raw.tokenRefs) || raw.tokenRefs.length === 0) return null;
    refs.push(...raw.tokenRefs);
  }
  if (refs.length === 0 || !refs.every(validTokenRef)) return null;
  return [...new Set(refs)];
}

const sameStore = (a, b) => JSON.stringify(a ?? { kind: 'windows' }) === JSON.stringify(b ?? { kind: 'windows' });

const projectRef = (ref) => ref.startsWith(`${CAMPAIGN_TOKEN_PREFIX}:`) && PROJECT_ID.test(ref.slice(CAMPAIGN_TOKEN_PREFIX.length + 1));

/**
 * The existing `campaignApi` (`{}` when absent) and which of its references `ref` joins: `kept`, the other projects'
 * references, carried over only while the API is enabled; `dropped`, its enabled references not tied to a project,
 * which reach every repository and so are never kept beside a project's token. A `campaignApi` that is not an object,
 * or names a malformed reference, refuses (CONFIG_INVALID) rather than being rewritten around.
 */
function currentCampaignApi(config, ref) {
  const current = config.campaignApi;
  if (current === undefined) return { current: {}, kept: [], dropped: [] };
  const invalid = () => new CampaignError('CONFIG_INVALID', 'config.json campaignApi is malformed; fix it before creating a campaign API token');
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw invalid();
  const known = current.tokenRef === undefined && current.tokenRefs === undefined ? [] : configuredTokenRefs(current);
  if (known === null) throw invalid();
  const active = current.enabled === true ? known.filter((existing) => existing !== ref) : [];
  return { current, kept: active.filter(projectRef), dropped: active.filter((existing) => !projectRef(existing)) };
}

/**
 * Add `ref` to `config.json` `campaignApi`, keeping every other project's reference already there while the API is
 * enabled, so issuing one project's token never switches another's off; a reference not tied to a project is dropped
 * (it would reach every repository), and a switched-off API comes back with `ref` alone. One reference is written as
 * `{ enabled: true, tokenRef: ref }`, the shape every installation understands; several as `{ enabled: true, tokenRefs:
 * [...] }`. `credentialStore` is the caller's, else the one already configured; the API listener port is preserved.
 * Nothing about the project id is stored here; config.json never holds a secret value (AGENTS.md: "configuration holds
 * executable paths and repository paths, never secret values").
 */
export function applyCampaignApiConfig(dataDir, ref, { credentialStoreSpec } = {}) {
  const configFile = join(dataDir, 'config.json');
  const config = readConfig(dataDir);
  const { current, kept } = currentCampaignApi(config, ref);
  const refs = [...kept, ref];
  const store = credentialStoreSpec ?? current.credentialStore;
  config.campaignApi = { enabled: true, ...(refs.length === 1 ? { tokenRef: ref } : { tokenRefs: refs }), ...(store ? { credentialStore: store } : {}),
    ...(current.port === undefined ? {} : { port: current.port }) };
  writeAtomic(configFile, JSON.stringify(config, null, 2));
  return config.campaignApi;
}

/**
 * Create or rotate a registered project's campaign-API token. `rotate: false` (create) refuses to overwrite a value
 * already stored under the reference (TOKEN_ALREADY_EXISTS: use rotate instead); `rotate: true` refuses when nothing
 * is there yet to rotate (TOKEN_NOT_FOUND: use create first). Either way the fresh random value replaces or creates
 * the store entry and its reference is added to `config.json` `campaignApi` beside the other projects' references
 * (rotate replaces only this project's value), unless `applyConfig: false` -- for a caller that
 * would rather print the exact patch than touch config.json itself. Returns `{ projectId, ref, rotated, config,
 * dropped }`, `config` being the resulting `campaignApi` setting (or null when `applyConfig: false`) and `dropped` the
 * references not tied to a project that it switched off; the token value is never part of the return.
 */
export function issueCampaignToken(projectId, { governanceRoot, dataDir, rotate = false, credentialStoreSpec, applyConfig = true, randomToken = () => randomBytes(32).toString('base64url') } = {}) {
  assertRegisteredProjectId(projectId, governanceRoot);
  const ref = campaignTokenRef(projectId);
  // config.json is checked before the store is written, so a refusal leaves both untouched. Every configured reference
  // resolves from the one configured store, so a token is written there unless the caller names a store, and naming a
  // different one while other projects' tokens are configured would cut them off.
  let storeSpec = credentialStoreSpec, dropped = [];
  if (applyConfig) {
    const { current, kept, dropped: unscoped } = currentCampaignApi(readConfig(dataDir), ref);
    if (credentialStoreSpec && kept.length && !sameStore(credentialStoreSpec, current.credentialStore)) {
      throw new CampaignError('CREDENTIAL_STORE_MISMATCH', `config.json campaignApi already names other tokens in a different credential store; issue ${ref} into that store`);
    }
    storeSpec = credentialStoreSpec ?? current.credentialStore;
    dropped = unscoped;
  }
  const store = tokenStoreFrom(storeSpec);
  let existed;
  try { existed = store.has(ref) === true; }
  catch (error) { throw new CampaignError('CREDENTIAL_STORE_UNREADABLE', `cannot tell whether ${ref} already exists: ${error.message}`); }
  if (existed && !rotate) throw new CampaignError('TOKEN_ALREADY_EXISTS', `${ref} already exists; run campaign-token rotate ${projectId} to replace it`);
  if (!existed && rotate) throw new CampaignError('TOKEN_NOT_FOUND', `${ref} does not exist yet; run campaign-token create ${projectId} first`);
  store.set(ref, randomToken());
  const config = applyConfig ? applyCampaignApiConfig(dataDir, ref, { credentialStoreSpec: storeSpec }) : null;
  return { projectId, ref, rotated: existed, config, dropped };
}
