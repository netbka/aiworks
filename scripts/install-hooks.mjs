import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
const git = (...args) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
if (git('rev-parse', '--git-dir').status === 0) {
  const current = git('config', '--local', '--get', 'core.hooksPath').stdout?.trim();
  const hooks = git('rev-parse', '--git-path', 'hooks').stdout?.trim();
  const custom = !current && hooks && existsSync(hooks) && readdirSync(hooks).some(name => !name.endsWith('.sample'));
  if (custom || (current && current !== '.githooks')) {
    console.error('Existing Git hooks preserved. Add the AIWorks pre-commit and pre-push checks to your hook chain before publishing.');
    process.exitCode = 1;
  } else if (git('config', '--local', 'core.hooksPath', '.githooks').status !== 0) {
    console.error('Cannot install privacy hooks. Run git config --local core.hooksPath .githooks in this checkout before committing.');
    process.exitCode = 1;
  }
}
