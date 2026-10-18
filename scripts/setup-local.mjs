import { cpSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function setupLocal(root = source) {
  const local = join(root, '.local');
  mkdirSync(local, { recursive: true });
  if (lstatSync(local).isSymbolicLink()) throw new Error('The installation .local directory must not be a symlink.');
  const destination = join(local, 'governance');
  // Exclusive creation preserves existing authority and installation data, including partial previous setups.
  mkdirSync(destination);
  cpSync(join(source, 'resources/governance'), destination, { recursive: true, errorOnExist: true, force: false });
  mkdirSync(join(destination, 'registry/projects'));
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { setupLocal(); console.log('Created .local/governance with an empty project registry. No project or work is authorized.'); }
  catch (error) {
    console.error(error.code === 'EEXIST' ? 'Existing local governance preserved; setup creates new installations only.' : 'Cannot create local governance. Inspect the installation locally; no existing files were replaced.');
    process.exitCode = 1;
  }
}
