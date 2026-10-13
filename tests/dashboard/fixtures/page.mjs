// The owner page as the browser builds it, without a browser: src/dashboard/public/index.html parsed into a small fake
// DOM, and src/dashboard/public/dashboard.js run on it unchanged against the real dashboard server (createDashboardServer)
// serving a review fixture. Tests read the text the owner sees on each screen. Disposable directories, local git and a
// loopback server only: no browser, network, model or GitHub call.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createDashboardServer } from '../../../src/dashboard/server.mjs';
import { configuredCheckouts, configuredGitCommand, MergeWatcher, publishedSteps } from '../../../src/dashboard/merges.mjs';
import { buildReviewFixture } from './review-store.mjs';

const PUBLIC = resolve(import.meta.dirname, '../../../src/dashboard/public');
const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'source']);

class Text {
  constructor(text) { this.nodeType = 3; this.data = String(text); this.parentNode = null; }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
}

/** Selectors the page uses: compound tag, #id, .class and [attr], [attr="v"], [attr^="v"], comma-separated. */
function matches(node, selector) {
  return selector.split(',').some((one) => {
    const part = one.trim(), tag = /^[a-z]+/i.exec(part)?.[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    for (const [, kind, name] of part.matchAll(/([#.])([\w-]+)/g)) {
      if (kind === '#' && node.getAttribute('id') !== name) return false;
      if (kind === '.' && !node.classList.contains(name)) return false;
    }
    for (const [, name, op, value] of part.matchAll(/\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g)) {
      const actual = node.getAttribute(name);
      if (actual === null || op === '=' && actual !== value || op === '^=' && !actual.startsWith(value)) return false;
    }
    return true;
  });
}

class Element {
  constructor(document, tag) {
    Object.assign(this, { ownerDocument: document, nodeType: 1, tagName: tag.toUpperCase(), attributes: new Map(), childNodes: [], parentNode: null, listeners: {} });
    const node = this;
    this.classList = {
      contains: (name) => (node.getAttribute('class') ?? '').split(/\s+/).includes(name),
      toggle(name, force) { const has = this.contains(name), on = force ?? !has; if (on !== has) node.className = on ? `${node.className} ${name}`.trim() : node.className.split(/\s+/).filter((item) => item !== name).join(' '); },
    };
    this.dataset = new Proxy({}, { get: (_, key) => node.getAttribute(`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined });
    this.style = {};
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttributeNames() { return [...this.attributes.keys()]; }
  hasAttribute(name) { return this.attributes.has(name); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get id() { return this.getAttribute('id') ?? ''; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get open() { return this.hasAttribute('open'); }
  set open(value) { if (value) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get checked() { return this.hasAttribute('checked'); }
  set checked(value) { if (value) this.setAttribute('checked', ''); else this.removeAttribute('checked'); }
  get value() {
    if ('_value' in this) return this._value;
    if (this.tagName === 'SELECT') return (this.querySelectorAll('option').find((o) => o.hasAttribute('selected')) ?? this.querySelector('option'))?.getAttribute('value') ?? '';
    return this.getAttribute('value') ?? (this.tagName === 'TEXTAREA' ? this.textContent : '');
  }
  set value(value) { this._value = String(value); }
  get children() { return this.childNodes.filter((child) => child.nodeType === 1); }
  get textContent() { return this.childNodes.map((child) => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(String(value)); }
  get elements() {
    const form = this;
    return new Proxy({}, { get: (_, name) => {
      const named = form.querySelectorAll(`[name="${String(name)}"]`);
      if (named.length) return { value: (named.find((item) => item.checked) ?? named[0]).value };
      return form.querySelector(`#${String(name)}`);
    } });
  }
  append(...children) {
    for (const child of children) {
      // Like the DOM, anything that is not a node is appended as its string.
      const node = child?.nodeType ? child : new Text(String(child));
      node.parentNode?.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
      node.parentNode = this; this.childNodes.push(node);
    }
  }
  replaceChildren(...children) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this.append(...children); }
  replaceChild(node, old) {
    node.parentNode?.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    this.childNodes.splice(this.childNodes.indexOf(old), 1, node); node.parentNode = this; old.parentNode = null; return old;
  }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
  *walk() { for (const child of this.childNodes) if (child.nodeType === 1) { yield child; yield* child.walk(); } }
  querySelectorAll(selector) { return [...this.walk()].filter((node) => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { for (let node = this; node?.nodeType === 1; node = node.parentNode) if (matches(node, selector)) return node; return null; }
  contains(other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  dispatchEvent(event) {
    event.target ??= this;
    for (let node = this; node; node = node.parentNode) for (const listener of node.listeners?.[event.type] ?? []) listener(event);
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  // Focus is announced the way a browser does, with a focusin event that bubbles to the document.
  focus() { this.ownerDocument.activeElement = this; this.dispatchEvent(new Event('focusin')); }
  // No layout here: a test places an element by setting `rect`, as a browser at a given width would.
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...this.rect }; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

class Event {
  constructor(type) { Object.assign(this, { type, target: null, defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }); }
  preventDefault() { this.defaultPrevented = true; }
}

/** index.html as a tree: tags, attributes and text. Enough for the page's own well-formed markup. */
function parse(document, html) {
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  const root = document.createElement('body'), stack = [root];
  for (const [, close, tag, attributes, text] of body.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
    if (text !== undefined) { const value = text.replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&'); if (value.trim()) stack.at(-1).append(value); continue; }
    if (close) { stack.pop(); continue; }
    const node = document.createElement(tag);
    for (const [, name, , value] of attributes.matchAll(/([\w-]+)(=("([^"]*)"))?/g)) node.setAttribute(name, value === undefined ? '' : value.slice(1, -1));
    stack.at(-1).append(node);
    if (!VOID.has(tag.toLowerCase()) && !attributes.trim().endsWith('/')) stack.push(node);
  }
  return root;
}

/** One loopback request to the dashboard server, the way a same-origin browser page sends it. */
function call(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { origin: `http://127.0.0.1:${port}` } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); done({ ok: res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text) }); });
    });
    req.on('error', fail);
    req.end(body);
  });
}

/**
 * Serves the review fixture (`store`: 'full' or 'empty') with the dashboard's own server and loads the page. Returns
 * { document, go(address), settle(), text(), dataDir, now }. Cleans up with the test.
 */
export async function openPage(t, { store = 'full', host = 'review-pc' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-page-'));
  const fixture = buildReviewFixture(join(root, 'review'), { store });
  const { dataDir } = fixture;
  const merges = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: configuredCheckouts(dataDir), git: configuredGitCommand(dataDir) });
  await merges.refresh();
  const roadmap = { snapshot: () => ({ entries: [], governance: { configured: false, reason: 'Not used by this test.' } }) };
  const server = createDashboardServer({ dataDir, roadmap, merges, host: { name: host, revision: '0123456789ab' } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  // The server stops first, then any merge check it started (a git fetch in the fixture's checkouts) ends before the
  // directory is removed.
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, 'close').catch(() => {}); await merges.refreshing; rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

  const document = {
    activeElement: null, title: '', visibilityState: 'visible', listeners: {},
    createElement: (tag) => new Element(document, tag), createTextNode: (text) => new Text(text),
    querySelector: (selector) => document.body.querySelector(selector), querySelectorAll: (selector) => document.body.querySelectorAll(selector),
    addEventListener: Element.prototype.addEventListener,
  };
  document.body = parse(document, readFileSync(join(PUBLIC, 'index.html'), 'utf8'));
  // Clicks bubble from the body to the document, where the page listens for links to other screens.
  document.body.parentNode = { listeners: document.listeners };
  const location = { hash: '' };
  const window = { scrollY: 0, innerHeight: 720, scrollTo: (x, y) => { window.scrollY = y; }, scrollBy: (x, y) => { window.scrollY += y; }, listeners: {}, addEventListener: Element.prototype.addEventListener };
  const history = { scrollRestoration: 'auto', pushState: (_, __, address) => { location.hash = address; }, replaceState: (_, __, address) => { location.hash = address; } };
  const storage = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) }; };
  let pending = 0, tick = () => {};
  const fetch = async (path, options = {}) => {
    pending++;
    try { return await call(port, path, { method: options.method, headers: options.headers, body: options.body }); } finally { pending--; }
  };
  // The page's 5-second refresh does not run by itself here; refresh() runs it once.
  const page = { document, window, location, history, localStorage: storage(), sessionStorage: storage(), fetch, setInterval: (callback) => { tick = callback; return 0; } };
  // The page imports /router.mjs and /copy.mjs from the server; here the same files from disk. Its browser globals
  // are this page's own, so pages of two tests never share state.
  const source = readFileSync(join(PUBLIC, 'dashboard.js'), 'utf8')
    .replace("from '/router.mjs'", `from '${pathToFileURL(join(PUBLIC, 'router.mjs')).href}'`)
    .replace("from '/copy.mjs'", `from '${pathToFileURL(join(PUBLIC, '../copy.mjs')).href}'`);
  const key = `page${Math.random().toString(36).slice(2)}`;
  globalThis[key] = page;
  const file = join(root, `${key}.mjs`);
  writeFileSync(file, `const { document, window, location, history, localStorage, sessionStorage, fetch, setInterval } = globalThis.${key};\n${source}`);
  await import(pathToFileURL(file).href);
  delete globalThis[key];

  const settle = async () => { for (let i = 0; i < 400 && (pending || i < 5); i++) await new Promise((done) => setImmediate(done)); };
  /** Opens an address the way Back, Forward or an edited address does, then waits for the page to finish. */
  const go = async (address) => { location.hash = address; window.listeners.hashchange?.forEach((listener) => listener(new Event('hashchange'))); await settle(); };
  await settle();
  return { document, window, location, go, settle, dataDir, fixture, port, poll: () => go(location.hash), refresh: async () => { tick(); await settle(); },
    $: (selector) => document.querySelector(selector), text: () => visibleText(document.body) };
}

const ATTRIBUTES = ['title', 'placeholder', 'aria-label'];
/**
 * The words the owner reads without opening anything: text and the title, placeholder and aria-label attributes of every
 * element that is not hidden, outside a details disclosure (a disclosure's summary counts: it is always shown) and
 * outside a dialog that is not open.
 */
export function visibleText(node, { dialogs = false } = {}) {
  const out = [];
  const visit = (current, inDetails) => {
    if (current.nodeType === 3) { if (!inDetails) out.push(current.data); return; }
    if (current.hidden || ['SCRIPT', 'STYLE', 'TEMPLATE'].includes(current.tagName)) return;
    if (current.tagName === 'DIALOG' && !current.open && !dialogs) return;
    if (!inDetails) for (const name of ATTRIBUTES) if (current.getAttribute(name)) out.push(current.getAttribute(name));
    for (const child of current.childNodes) visit(child, current.tagName === 'DETAILS' && !(child.nodeType === 1 && child.tagName === 'SUMMARY') ? true : inDetails);
  };
  visit(node, false);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Internal words the owner never reads outside a details disclosure (OWNER_WORKSPACE §2.2; aiworks#11 review F3, F7). */
export const INTERNAL_WORDS = [/\bB[2-4]\b/, /\bexecutors?\b/i, /\bcampaigns?\b/i, /\bT\d+\b/, /\bcontrollers?\b/i, /cli\.mjs/, /campaigns\//, /\bAW-\d{3}\b/,
  /\bdeclarations?\b/i, /checker accepted/i, /owner-reserved/i];
/** The internal words found in `text`, each with a little context. */
export const internalWords = (text) => INTERNAL_WORDS.flatMap((word) => [...text.matchAll(new RegExp(word.source, `${word.flags}g`))]
  .map((m) => `${m[0]} in “…${text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60)}…”`));
