// Inspect the Git index, including force-added ignored files, without reading their contents.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function privatePaths(paths) {
  return paths.filter(path => /^(?:campaigns|\.local|runs|backups|state)\//.test(path) ||
    /(?:^|\/)config\.json$/.test(path) ||
    /(?:^|\/)\.env(?:$|\.(?!example$))/.test(path) ||
    /\.(?:db(?:-wal|-shm)?|sqlite3?|pem|key|pfx|p12|log)$/i.test(path));
}
export function checkPublicScope(root = process.cwd()) {
  const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (git.error || git.status !== 0) throw new Error('Cannot inspect the public commit scope.');
  const excluded = privatePaths(git.stdout.split('\0').filter(Boolean));
  if (excluded.length) throw new Error(`Private installation files are in the Git index:\n${excluded.join('\n')}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkPublicScope(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
