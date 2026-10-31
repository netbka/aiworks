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

// Short goal and step titles for Home (docs/design/HOME_V2.md): plain words for the owner, never a code, number, hash or
// id. A leading label before ":" goes when it holds a code, wave or step name; references, parentheses, hashes and ids
// go everywhere; the rest is cut at 60 characters on a word.
const TITLE_MAX = 60;
const CODE = /\b[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+\b|\b[A-Z]{1,6}\d+[a-z]?\b/;
const NAMED = /\b(?:wave|step|phase|slice|stage|part|task|wp)[\s-]*[A-Za-z]?\d+[a-z]?\b|\bv\d+(?:\.\d+)*\b/i;
// Small words a cut or a removed reference can leave dangling: "fixed in #12" is "Fixed", never "Fixed in".
const SMALL = '(?:a|an|and|as|at|by|for|from|in|into|of|on|or|the|to|with)';
const DANGLING = new RegExp(`\\s+${SMALL}$`, 'i');
const GONE = '\u0000', BEFORE_GONE = new RegExp(`(?:\\s*\\b${SMALL}\\b)*\\s*${GONE}`, 'gi');
const NOISE = [
  /\([^()]*\)|\[[^[\]]*\]/g, // parentheses and brackets, with what they hold
  /\bhttps?:\/\/\S+/g, // links
  /(?:\b[\w.-]+(?:\/[\w.-]+)?)?#\d+\b/g, // "#123", "repo#123", "owner/repo#123"
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/gi, // commit hashes
  /\b(?=[\w.-]*\d)[a-z0-9]+(?:[._-][a-z0-9]+){1,}\b/gi, // ids with a digit: aw-home-v2-20261031, v1.2.3
  new RegExp(NAMED.source, 'gi'), // wave, step and version names: wave 2, step 3, v2
  new RegExp(CODE.source, 'g'), // codes like AW-016, WP3, T1, HOME-V2-DATA
  /\b\d{3,}\b/g, // bare long numbers
];

/** The owner's title from `text`, or null when nothing plain is left. */
export function plainTitle(text) {
  let value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  const label = /^([^:]{1,60}):\s+(.+)$/.exec(value);
  if (label && (CODE.test(label[1]) || NAMED.test(label[1]))) value = label[2];
  for (const pattern of NOISE) value = value.replace(pattern, ` ${GONE} `);
  value = value.replace(BEFORE_GONE, ' ').replace(/[`*_#<>{}|\\]/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ')
    .replace(/^[\s,.;:–—-]+|[\s,;:–—-]+$/g, '').replace(/\(\s*\)/g, '').trim();
  // A sentence's full stop is not part of a title.
  value = value.replace(/\.$/, '');
  if (!/[A-Za-z]/.test(value)) return null;
  if (value.length > TITLE_MAX) {
    const cut = value.slice(0, TITLE_MAX + 1), space = cut.lastIndexOf(' ');
    value = (space > 0 ? cut.slice(0, space) : value.slice(0, TITLE_MAX)).replace(/[\s,;:–—-]+$/, '');
  }
  while (DANGLING.test(value)) value = value.replace(DANGLING, '');
  return value.charAt(0).toUpperCase() + value.slice(1);
}
