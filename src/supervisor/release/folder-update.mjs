// The fast-forward of a GitHub project's own folder to its merged base (AW-018; merge.mjs updateFolder decides when and
// records it). Merge calls live only under release/ (REL5). Only a fast-forward of the base branch, and only when that
// branch is checked out in the folder with nothing uncommitted (untracked files included) and no commits of the owner's
// own. Anything else is left as it is and named. No hook of the folder runs and no remote is read: the merged base was
// fetched before. The fast-forward itself also refuses to touch a file changed in the meantime.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import * as gitA from '../adapters/git.mjs';

const SHA = /^[0-9a-f]{40}$/;

/**
 * Move `branch` in the folder at `path` to `target` by fast-forward. Returns { updated: true, from, to, already } or
 * { updated: false, reason }: `other-branch`, `changes`, `own-commits` or `unreadable`. `hooksOff` is a directory that
 * does not exist, used as the hooks path. With `expectedHead`, the folder must still be at that commit (`changes`
 * otherwise). Git writes over ignored files, so a fast-forward that would add a path already on disk, or change a path
 * inside an ignored folder that exists there (such as AIWorks's own `.local/`), is refused as `changes`.
 */
export function fastForwardFolder({ git, path, branch, target, hooksOff, expectedHead = null }) {
  if (!SHA.test(target ?? '')) return { updated: false, reason: 'unreadable' };
  const run = (...args) => gitA.exec(git, ['-c', 'core.fsmonitor=false', ...args], { cwd: path, timeoutMs: 120_000 });
  const headAt = () => { const read = run('rev-parse', '--verify', '--quiet', 'HEAD^{commit}'); return read.ok && SHA.test(read.stdout) ? read.stdout : null; };
  const checkedOut = run('symbolic-ref', '-q', 'HEAD');
  if (!checkedOut.ok) return { updated: false, reason: checkedOut.status === 1 ? 'other-branch' : 'unreadable' };
  if (checkedOut.stdout !== `refs/heads/${branch}`) return { updated: false, reason: 'other-branch' };
  const status = run('status', '--porcelain=v1', '-z', '--untracked-files=all');
  if (!status.ok) return { updated: false, reason: 'unreadable' };
  if (status.stdout.length) return { updated: false, reason: 'changes' };
  const head = headAt();
  if (!head) return { updated: false, reason: 'unreadable' };
  if (expectedHead && head !== expectedHead) return { updated: false, reason: 'changes' };
  if (gitA.isAncestor({ git, path, ancestor: target, descendant: head })) return { updated: true, from: head, to: head, already: true };
  if (!gitA.isAncestor({ git, path, ancestor: head, descendant: target })) return { updated: false, reason: 'own-commits' };
  const changed = run('diff', '--name-only', '-z', '--no-renames', head, target);
  const added = run('diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', head, target);
  const ignored = run('ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory');
  if (!changed.ok || !added.ok || !ignored.ok) return { updated: false, reason: 'unreadable' };
  const list = (out) => out.stdout.split('\0').filter(Boolean);
  const fold = (file) => (process.platform === 'win32' ? file.toLowerCase() : file).replace(/\/+$/, '');
  const ignoredDirs = list(ignored).map(fold);
  const underIgnored = (file) => { const f = fold(file); return ignoredDirs.some((dir) => f === dir || f.startsWith(`${dir}/`) || dir.startsWith(`${f}/`)); };
  const onDisk = (file) => { try { lstatSync(join(path, ...file.split('/'))); return true; } catch { return false; } };
  if (list(changed).some(underIgnored) || list(added).some(onDisk)) return { updated: false, reason: 'changes' };
  const moved = run('-c', `core.hooksPath=${hooksOff}`, 'merge', '--ff-only', '-q', target);
  const now = headAt();
  if (!moved.ok || now !== target) return { updated: false, reason: now === head ? 'changes' : 'unreadable' };
  return { updated: true, from: head, to: target, already: false };
}
