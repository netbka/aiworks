import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { safeText } from './roadmap.mjs';

const CHECKING = '[Checking this text before displaying it…]';
const UNAVAILABLE = '[Text check could not finish. The original remains in the work records.]';
const SENSITIVE = '[sensitive content omitted]';

// One owned thread, at most 20 queued bodies (8 MiB of UTF-16 text), and 512 small
// exact-content receipts keep repeated polls and a page of 200 comments bounded.
export class DisplayTextChecks {
  #entries = new Map();
  #active = null;
  #closed = false;

  read(value, max) {
    const text = String(value ?? '').slice(0, max);
    if (text.length <= 256) return { state: 'ready', text: safeText(text, max) };
    if (this.#closed || text.length > 200000) return { state: 'unavailable', text: UNAVAILABLE };
    const key = createHash('sha256').update(text, 'utf16le').digest('hex');
    let entry = this.#entries.get(key);
    if (!entry) {
      if ([...this.#entries.values()].filter(e => e.state === 'checking').length >= 20) return { state: 'checking', text: CHECKING };
      if (this.#entries.size >= 512) {
        const oldest = [...this.#entries].find(([, e]) => e.state !== 'checking');
        if (oldest) this.#entries.delete(oldest[0]);
      }
      entry = { state: 'checking', body: text, sensitive: null };
      this.#entries.set(key, entry);
      this.#next();
    }
    return { state: entry.state, text: entry.state === 'ready' ? (entry.sensitive ? SENSITIVE : text)
      : entry.state === 'checking' ? CHECKING : UNAVAILABLE };
  }

  #next() {
    if (this.#active || this.#closed) return;
    const entry = [...this.#entries.values()].find(e => e.state === 'checking');
    if (!entry) return;
    let worker;
    try {
      worker = new Worker(new URL(import.meta.url), {
        workerData: entry.body, execArgv: [], env: {}, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
      });
    } catch {
      entry.state = 'unavailable'; delete entry.body;
      queueMicrotask(() => this.#next());
      return;
    }
    this.#active = worker;
    let sensitive = null, failed = false;
    const timeout = setTimeout(() => { failed = true; void worker.terminate(); }, 5000);
    timeout.unref();
    worker.stdout.resume(); worker.stderr.resume();
    worker.on('message', value => { if (!failed && typeof value === 'boolean') sensitive = value; });
    worker.on('error', () => { failed = true; });
    worker.on('exit', code => {
      clearTimeout(timeout);
      entry.state = !failed && code === 0 && sensitive !== null ? 'ready' : 'unavailable';
      entry.sensitive = sensitive; delete entry.body;
      this.#active = null;
      this.#next();
    });
    worker.unref();
  }

  async close() {
    this.#closed = true;
    this.#entries.clear();
    if (this.#active) await this.#active.terminate();
  }
}

if (!isMainThread) {
  parentPort.postMessage(safeText(workerData, workerData.length) !== workerData);
}
