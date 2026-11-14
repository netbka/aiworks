import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
const git = (...args) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
if (git('rev-parse', '--git-dir').status === 0) {
  const current = git('config', '--local', '--get', 'core.hooksPath').stdout?.trim();
  const hooks = git('rev-parse', '--git-path', 'hooks').stdout?.trim();
  const custom = !current && hooks && existsSync(hooks) && readdirSync(hooks).some(name => !name.endsWith('.sample'));
  // An absolute path to this repository's own .githooks (of this checkout or of the main checkout its worktrees share
  // config with) is the AIWorks hooks, written absolute by a tool outside AIWorks (work item 85). It is put back to the
  // relative form, which every worktree resolves to its own .githooks. Any other hooks path is someone's own and stays.
  const top = git('rev-parse', '--show-toplevel').stdout?.trim();
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir').stdout?.trim();
  const ours = [top, common && dirname(common)].filter(Boolean).map((root) => resolve(root, '.githooks'));
  const ownAbsolute = Boolean(current) && isAbsolute(current) && ours.some((path) => same(resolve(current), path));
  if (custom || (current && current !== '.githooks' && !ownAbsolute)) {
    console.error('Existing Git hooks preserved. Add the AIWorks pre-commit and pre-push checks to your hook chain before publishing.');
    process.exitCode = 1;
  } else if (git('config', '--local', 'core.hooksPath', '.githooks').status !== 0) {
    console.error('Cannot install privacy hooks. Run git config --local core.hooksPath .githooks in this checkout before committing.');
    process.exitCode = 1;
  }
}
