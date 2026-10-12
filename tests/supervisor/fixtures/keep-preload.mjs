// Test preload for `cli.mjs keep` (node --import): the keeper spawns a synthetic child (KEEP_TEST_CHILD, Node code)
// instead of `serve`, and once KEEP_TEST_TRIGGER exists it receives KEEP_TEST_SIGNAL. On Windows a signal from another
// process terminates without running listeners, so the console event is delivered in-process, to the keeper's own listener.
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const realSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => realSpawn(command, ['-e', process.env.KEEP_TEST_CHILD], options);
syncBuiltinESMExports();

const signal = process.env.KEEP_TEST_SIGNAL;
if (signal) {
  const timer = setInterval(() => {
    if (!existsSync(process.env.KEEP_TEST_TRIGGER)) return;
    clearInterval(timer);
    process.emit(signal, signal);
  }, 50);
  timer.unref();
}
