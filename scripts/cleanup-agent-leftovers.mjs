// Removes what manual agent sessions leave behind: merged worktree-agent-* branches,
// clean worktrees of merged branches under .claude/worktrees and .worktrees (with their
// local branches), orphan folders there that hold only node_modules or logs, and root
// gate*.log files. Dry run by default; --apply deletes. Never forces, never touches a
// dirty worktree, an unmerged branch, a remote branch, or anything under .local/.
// A worktree Claude Code locked for an agent is kept while the session that locked it
// runs; once that process is gone the lock is stale and is lifted before removal.
// One failed removal is reported and the rest still run; the exit code is then 1.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const apply = process.argv.includes('--apply');
const root = resolve(import.meta.dirname, '..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...a) => { try { return git(...a); } catch { return null; } };
const act = (what, fn) => {
  console.log(`${apply ? 'remove' : 'would remove'}: ${what}`);
  if (!apply) return true;
  try { fn(); return true; } catch (error) {
    console.log(`failed: ${what}: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    process.exitCode = 1;
    return false;
  }
};
const norm = (p) => resolve(p).toLowerCase();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

const main = tryGit('rev-parse', '--verify', 'origin/main') ? 'origin/main' : 'main';
const merged = (ref) => tryGit('merge-base', '--is-ancestor', ref, main) !== null;

const trees = [];
let cur = null;
for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
  if (line.startsWith('worktree ')) trees.push(cur = { path: line.slice(9) });
  else if (line.startsWith('branch ')) cur.branch = line.slice(18);
  else if (line === 'locked' || line.startsWith('locked ')) cur.locked = line.slice(7).trim();
}
const registered = new Set(trees.map((t) => norm(t.path)));
const inUse = new Set(trees.map((t) => t.branch).filter(Boolean));
const here = tryGit('branch', '--show-current');
const reported = new Set();
const dropBranch = (b) => {
  if (b === here || inUse.has(b) || reported.has(b) || !merged(b)) return;
  reported.add(b);
  act(`branch ${b}`, () => git('branch', '-d', b));
};

for (const t of trees) {
  if (norm(t.path) === norm(root) || !t.branch) continue;
  const rel = norm(t.path);
  if (![join(root, '.claude', 'worktrees'), join(root, '.worktrees')].some((d) => rel.startsWith(norm(d)))) continue;
  const clean = execFileSync('git', ['-C', t.path, 'status', '--porcelain'], { encoding: 'utf8' }).trim() === '';
  if (!clean || !merged(t.branch)) { console.log(`keep: worktree ${t.path} (${clean ? 'branch not merged' : 'has changes'})`); continue; }
  let unlock = false;
  if (t.locked !== undefined) {
    const pid = Number(/^claude agent \S+ \(pid (\d+)\)$/.exec(t.locked)?.[1]);
    if (!pid) { console.log(`keep: worktree ${t.path} (locked: ${t.locked || 'no reason given'})`); continue; }
    if (alive(pid)) { console.log(`keep: worktree ${t.path} (locked by Claude Code process ${pid}, still running; removed after it exits)`); continue; }
    unlock = true;
  }
  const what = `worktree ${t.path}${unlock ? ' (stale Claude Code lock)' : ''}`;
  if (act(what, () => { if (unlock) git('worktree', 'unlock', t.path); git('worktree', 'remove', t.path); })) {
    inUse.delete(t.branch);
    dropBranch(t.branch);
  }
}

for (const b of git('for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-agent-*').split('\n').filter(Boolean)) {
  if (b === here || inUse.has(b) || reported.has(b)) continue;
  if (merged(b)) dropBranch(b);
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
