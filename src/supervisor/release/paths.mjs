// Private release evidence and checkouts must never follow a redirected path
// into another project or an operator's working tree.
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export function releasePath(dataDir, ...parts) {
  const norm = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
  const root = norm(realpathSync.native(dataDir));
  let at = resolve(dataDir);
  for (const part of ['releases', ...parts]) {
    if (typeof part !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part === '.' || part === '..') throw new Error('Invalid private release path');
    at = join(at, part);
    let info;
    try { info = lstatSync(at); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink() || !norm(realpathSync.native(at)).startsWith(root + sep)) {
      throw new Error('A private release path was redirected outside its owned directory');
    }
  }
  return at;
}
