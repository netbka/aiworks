// A disposable rebuild process. The parent controls the stale-holder check and kills it to exercise crash recovery.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { rebuild } from '../../../src/supervisor/rebuild.mjs';

const [root, pause] = process.argv.slice(2);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
// IPC is initially unreferenced in a child; a pending Promise alone must not let the lock holder exit.
process.on('message', () => {});
let announced = false;
try {
  await rebuild({ root, source: root }, {
    processAlive(pid) {
      if (pause === 'pause') {
        process.send({ event: 'stale' });
        const deadline = Date.now() + 20_000;
        while (!existsSync(join(root, 'continue'))) {
          if (Date.now() >= deadline) throw new Error('parent did not release the stale-holder check');
          Atomics.wait(sleeper, 0, 0, 10);
        }
      }
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    },
    exec() {
      if (!announced) { announced = true; process.send({ event: 'entered' }); }
      // Hold the acquired lock until the parent terminates this disposable process.
      return new Promise(() => {});
    },
  });
} catch (error) {
  process.send({ event: 'refused', code: error.code, message: error.message });
  process.disconnect();
}
