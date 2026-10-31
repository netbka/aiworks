// Stack cleanup takes Docker Compose stacks down with their volumes (heavy-work.mjs). It must never touch a stack that a
// running step uses, one outside AIWorks's worktree root, or a project name another checkout shares. No Docker is run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStackSweeper } from '../../src/supervisor/heavy-work.mjs';

test('stack cleanup removes only stray stacks inside the worktree root, never one in use, outside it or shared', async () => {
  const root = 'W:/worktrees/sampleapp';
  const listing = [
    `stray-1\t${root}/finished-task`,
    `stray-1\t${root}/finished-task`,
    `in-use\t${root}/running-task`,
    `owner-dev\tW:/sampleapp`,
    `other-session\tW:/sampleapp/.worktrees/review`,
    `shared-name\t${root}/old-attempt`,
    `shared-name\tW:/sampleapp/.worktrees/deploy`,
  ].join('\n');
  const calls = [];
  let keepRead = false;
  const exec = async (docker, args) => {
    calls.push(args.join(' '));
    // What is in use is read after the listing, so a step recorded meanwhile is kept.
    if (args[0] === 'ps') { assert.equal(keepRead, false); return { ok: true, stdout: listing }; }
    return { ok: true, stdout: '' };
  };
  const sweeper = createStackSweeper({ exec, roots: () => [root], keep: () => { keepRead = true; return [`${root}/running-task`]; } });
  assert.deepEqual(await sweeper.sweep(), ['stray-1']);
  assert.deepEqual(calls.filter((call) => call.startsWith('compose')), ['compose -p stray-1 down -v --remove-orphans']);
});
