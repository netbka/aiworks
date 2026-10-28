// Read standing release authority from the uniquely registered project and a
// freshly fetched base. Private receipts remember version/digest continuity;
// neither a worker branch nor a dashboard label supplies release authority.
import { mkdirSync, readFileSync } from 'node:fs';
import { governanceForContract, registryEntriesFor } from '../campaign.mjs';
import { writeAtomic } from '../proc.mjs';
import { loadAuthorization, recordDigest, validateAuthorization } from './authorization.mjs';
import { releasePath } from './paths.mjs';

export function projectReleasePointer(controller, declaration) {
  const repository = declaration.target.repository;
  const entries = registryEntriesFor(repository, controller.governanceRoot);
  if (entries.length !== 1) throw new Error('Release needs one unambiguous registered project');
  const contract = entries[0];
  governanceForContract(contract, controller.governanceRoot, repository);
  if (contract.id !== declaration.target.projectId) throw new Error('Release project identity differs from campaign authority');
  const pointer = contract.governance?.releaseAuthorization;
  if (!pointer) return null;
  if (typeof pointer.source !== 'string' || typeof pointer.approval !== 'string') throw new Error('Release authority needs its project source and owner approval reference');
  return { project: contract.id, repository, source: pointer.source, approval: pointer.approval };
}

/** Called inside the campaign fence. Remember revocation even when the grant cannot admit new work. */
export function observeGrant(store, pointer, loaded, now) {
  if (!loaded.bytes) return { reason: loaded.reasons?.[0] ?? 'Release authority could not be read' };
  let record;
  try { record = JSON.parse(loaded.bytes.toString('utf8')); } catch { return { reason: 'Release authority is not a structured grant' }; }
  if (!record || typeof record !== 'object' || Array.isArray(record) || !Number.isFinite(Date.parse(record.grantedAt))) {
    return { reason: loaded.reasons?.[0] ?? 'Release authority is invalid' };
  }
  if (record.approval !== pointer.approval) return { reason: 'Release grant approval differs from the registered owner approval' };
  // Validate the historical identity separately from present-day expiry and
  // revocation, so an observed revoked version can never later be revived.
  const identity = typeof record.revoked === 'boolean' && validateAuthorization({ ...record, revoked: false },
    { project: pointer.project, now: Date.parse(record.grantedAt) + 1 });
  if (!identity?.valid) return { reason: loaded.reasons?.[0] ?? 'Release authority is invalid' };
  const seen = store.get('SELECT * FROM release_grants WHERE project = ?', pointer.project);
  if (seen?.version === record.version && record.revoked) {
    store.run('UPDATE release_grants SET revoked = 1, updated_at = ? WHERE project = ?', now, pointer.project);
    return { reason: 'This release grant version was revoked', record, digest: loaded.digest };
  }
  if (seen && (record.version < seen.version || record.version === seen.version &&
      (loaded.digest !== seen.digest || seen.source !== pointer.source || seen.approval !== pointer.approval))) {
    return { reason: 'Release grant version regressed or its approved contents changed without a new version' };
  }
  if (seen?.version === record.version && seen.revoked) return { reason: 'This release grant version was revoked' };
  store.run('INSERT INTO release_grants (project, version, digest, revoked, source, approval, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(project) DO UPDATE SET version=excluded.version, digest=excluded.digest, revoked=excluded.revoked, source=excluded.source, approval=excluded.approval, updated_at=excluded.updated_at',
  pointer.project, record.version, loaded.digest, record.revoked ? 1 : 0, pointer.source, pointer.approval, now);
  if (!loaded.valid) return { reason: loaded.reasons[0], record, digest: loaded.digest };
  return { record, digest: loaded.digest };
}

export function readProjectGrant(controller, ctx, declaration, repo, { fetch = true } = {}) {
  const pointer = projectReleasePointer(controller, declaration);
  if (!pointer) return { reason: 'No standing release grant is registered for this project', absent: true };
  const base = fetch ? controller.fetchBase(repo.path, declaration.target.baseBranch, declaration.target.repository).sha : null;
  if (fetch && !base) return { reason: 'The release base could not be fetched' };
  const ref = base ?? 'origin/' + declaration.target.baseBranch;
  const loaded = loadAuthorization({ git: controller.cmd.git, repoPath: repo.path, ref, path: pointer.source,
    project: pointer.project, now: controller.now(), mergeGate: { repository: pointer.repository, merges: controller.config.merges } });
  loaded.ref = 'origin/' + declaration.target.baseBranch;
  const grant = controller.fenced(ctx, () => observeGrant(controller.store, pointer, loaded, controller.now()));
  return { ...grant, pointer, loaded, base: base ?? loaded.commit };
}

const snapshotPath = (dataDir, id) => releasePath(dataDir, id, 'authorization.json');
export function pinGrant(dataDir, row, loaded) {
  if (recordDigest(loaded.bytes) !== row.grant_digest) throw new Error('The release grant changed before it could be pinned');
  mkdirSync(releasePath(dataDir, row.id), { recursive: true });
  writeAtomic(snapshotPath(dataDir, row.id), loaded.bytes);
}

/** Recovery uses the original commands, even after a new grant replaces them. */
export function pinnedGrant(dataDir, row) {
  const bytes = readFileSync(snapshotPath(dataDir, row.id));
  if (recordDigest(bytes) !== row.grant_digest) throw new Error('Pinned release authority does not match its recorded digest');
  const record = JSON.parse(bytes.toString('utf8'));
  if (record.project !== row.project || record.version !== row.grant_version) throw new Error('Pinned release authority belongs to another release');
  return record;
}
