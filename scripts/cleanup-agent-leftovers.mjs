// Removes what manual agent sessions leave behind: merged worktree-agent-* branches,
// clean worktrees of merged branches under .claude/worktrees and .worktrees, orphan
// folders there that hold only node_modules or logs, and root gate*.log files.
// Dry run by default; --apply deletes. Never forces, never touches a dirty worktree,
// an unmerged branch, a remote branch, or anything under .local/.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const apply = process.argv.includes('--apply');
const root = resolve(import.meta.dirname, '..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const tryGit = (...a) => { try { return git(...a); } catch { return null; } };
const act = (what, fn) => { console.log(`${apply ? 'remove' : 'would remove'}: ${what}`); if (apply) fn(); };
const norm = (p) => resolve(p).toLowerCase();

const main = tryGit('rev-parse', '--verify', 'origin/main') ? 'origin/main' : 'main';
const merged = (ref) => tryGit('merge-base', '--is-ancestor', ref, main) !== null;

const trees = [];
let cur = null;
for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
  if (line.startsWith('worktree ')) trees.push(cur = { path: line.slice(9) });
  else if (line.startsWith('branch ')) cur.branch = line.slice(18);
}
const registered = new Set(trees.map((t) => norm(t.path)));
const inUse = new Set(trees.map((t) => t.branch).filter(Boolean));
const here = tryGit('branch', '--show-current');

for (const t of trees) {
  if (norm(t.path) === norm(root) || !t.branch) continue;
  const rel = norm(t.path);
  if (![join(root, '.claude', 'worktrees'), join(root, '.worktrees')].some((d) => rel.startsWith(norm(d)))) continue;
  const clean = execFileSync('git', ['-C', t.path, 'status', '--porcelain'], { encoding: 'utf8' }).trim() === '';
  if (clean && merged(t.branch)) act(`worktree ${t.path}`, () => { git('worktree', 'remove', t.path); inUse.delete(t.branch); });
  else console.log(`keep: worktree ${t.path} (${clean ? 'branch not merged' : 'has changes'})`);
}

for (const b of git('for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-agent-*').split('\n').filter(Boolean)) {
  if (b === here || inUse.has(b)) continue;
  if (merged(b)) act(`branch ${b}`, () => git('branch', '-d', b));
  else console.log(`keep: branch ${b} (not merged into ${main})`);
}

for (const d of ['.claude/worktrees', '.worktrees']) {
  const base = join(root, d);
  if (!existsSync(base)) continue;
  for (const e of readdirSync(base, { withFileTypes: true })) {
    const p = join(base, e.name);
    if (registered.has(norm(p)) || !existsSync(p)) continue;
    const onlyDisposable = e.isDirectory()
      ? readdirSync(p).every((n) => n === 'node_modules' || n.endsWith('.log'))
      : e.name.endsWith('.log');
    if (onlyDisposable) act(`orphan ${p}`, () => rmSync(p, { recursive: true, force: true }));
    else console.log(`keep: orphan ${p} (holds other files)`);
  }
}

for (const n of readdirSync(root)) {
  if (/^gate[-\w]*\.log$/.test(n)) act(`log ${n}`, () => rmSync(join(root, n)));
}
tryGit('worktree', 'prune');
if (!apply) console.log('Dry run. Re-run with --apply to delete.');
