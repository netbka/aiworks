// A standing grant is owner authority, never an ordinary worker deliverable.
import { governanceForContract, registryEntriesFor } from '../campaign.mjs';
import { changedPaths } from '../adapters/git.mjs';

export function authorityPaths(controller, declaration) {
  // Local-folder authority is handled by its separate overlay/Apply path.
  if (!declaration.target.repository) return [];
  if (!controller.governanceRoot) throw new Error('The registered project authority is unavailable');
  const entries = registryEntriesFor(declaration.target.repository, controller.governanceRoot);
  if (entries.length !== 1) throw new Error('The registered project authority is missing or ambiguous');
  governanceForContract(entries[0], controller.governanceRoot, declaration.target.repository);
  const source = entries[0].governance?.releaseAuthorization?.source;
  return source ? [source] : [];
}

export function authorityChange(controller, declaration, repo, from, to) {
  const paths = authorityPaths(controller, declaration);
  if (!paths.length) return null;
  const changed = changedPaths({ git: controller.cmd.git, path: repo, from, to });
  if (changed === null) throw new Error('The release authority boundary could not be checked');
  const normalized = (path) => path.replaceAll('\\', '/').toLowerCase();
  return changed.some((file) => paths.some((path) => normalized(file) === normalized(path) || normalized(path).startsWith(normalized(file) + '/')))
    ? 'This change modifies registered release authority; ordinary campaign work cannot amend an owner grant' : null;
}
