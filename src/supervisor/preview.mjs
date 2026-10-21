// Preview of a checked version (docs/design/OWNER_UI_V2.md WP7). The owner opens the static web pages of exactly the
// commit that passed the independent check, next to its evidence in Review, at desktop or phone width. Containment:
// - only a finished step's verified head with an accepted verification of it and its report (result-review.mjs) is ever
//   previewed; a changed, unverified or reopened result is refused, and nothing in a request names a command or a path;
// - the files are read from Git objects of that commit with `ls-tree` and `cat-file` in AIWorks's own checkout. Nothing
//   from the project is run by AIWorks (its page scripts run only in the browser sandbox below): no build, no install, no server, no checkout, and nothing is written to disk;
// - only the folder of the preview's entry page is served, by exact tree path: `..`, encoded separators, links,
//   submodules, hidden files, secret-like names, credential-looking text and other file types are never served;
// - each response is a sandboxed document with an opaque origin (CSP `sandbox allow-scripts`, no same-origin): its script
//   cannot read the dashboard, its token or its commands, cannot send requests (connect-src 'none'), submit forms, open
//   windows or leave its frame, and only the dashboard may frame it. A preview lives in the dashboard's memory only and
//   ends after PREVIEW_TTL_MS, when the dashboard stops, or as soon as its version is no longer the checked one.
// Only the `static` runtime class is supported (PREVIEW_RUNTIMES); a version that needs its own server says so instead.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { containsSecret } from './coordinator.mjs';
import { verifiedReview } from './result-review.mjs';

const SHA = /^[0-9a-f]{40}$/;
/** Where a checked version's web page may be, in this order; the folder of the first found is all a preview serves. */
export const PREVIEW_ENTRIES = Object.freeze(['index.html', 'public/index.html', 'site/index.html', 'docs/index.html', 'www/index.html']);
export const PREVIEW_TTL_MS = 30 * 60_000;
/**
 * What kind of version a preview can show. `static`: pages read from the checked commit's Git objects, as above.
 * `server`: a version that needs its own process (a Node, Python or other app server) stays unavailable. A Job Object
 * bounds such a process's lifetime and process tree, but nothing on this platform keeps its network to loopback or its
 * file reads to its worktree, and its dependencies would first have to be installed, which runs their scripts too.
 */
export const PREVIEW_RUNTIMES = Object.freeze({
  static: Object.freeze({ supported: true }),
  server: Object.freeze({ supported: false, reason: 'AIWorks does not start a project’s own server: on this computer it cannot keep that program’s network to this computer or its file reads to the checked version.' }),
});
// Files that mean a version is an app with its own server rather than static pages.
const SERVER_MARKERS = Object.freeze(['package.json', 'manage.py', 'requirements.txt', 'pyproject.toml', 'Gemfile', 'go.mod', 'Cargo.toml', 'composer.json']);
/** How often an open preview checks again that its version is still the checked one. */
const RECHECK_MS = 1000;
/** Open previews at once; opening another ends the oldest. */
export const MAX_PREVIEWS = 4;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5000;
const TYPES = Object.freeze({ html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' });
const TEXT = /^(?:text\/|application\/json|image\/svg)/;
// Names that hold credentials or local configuration, never part of a page: `.env`, keys, certificates, npm and SSH files.
const SECRET_NAME = /(?:^|\/)(?:\.[^/]*|[^/]*\.(?:pem|key|p12|pfx|crt|cer|keystore|jks|kdbx)|id_(?:rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*(?:secret|credential)[^/]*)$/i;

/** The headers of every preview response: an opaque-origin sandbox the dashboard alone may frame. */
export const PREVIEW_POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; " +
  "worker-src 'none'; manifest-src 'none'; frame-ancestors 'self'";

export class PreviewError extends Error {
  constructor(code, message) { super(message); this.name = 'PreviewError'; this.code = code; }
}

/**
 * Whether Review can offer a preview of this step's result, with the reason in the owner's words when it cannot. Only
 * the cheap facts are read here; whether the checked version has a web page is known when the owner opens it.
 */
export function previewSupport(task, spec, review) {
  if (!review || !SHA.test(task?.verified_sha ?? '')) return { available: false, reason: 'No version of this step has passed the independent check yet.' };
  if (spec?.deliverable !== 'commit') return { available: false, reason: 'This step delivers a report, not a version to try.' };
  if (review.state === 'changes-requested') return { available: false, reason: 'You asked for changes, so this version is not previewed; the repaired version can be once it passes the check.' };
  if (review.state === 'no-evidence' || task.state !== 'done' || !verifiedReview(task)) return { available: false, reason: 'No independent check of this version is on record, so it is not previewed.' };
  return { available: true, reason: null };
}

/** One read-only Git command in AIWorks's checkout. Inherited GIT_* variables could point Git elsewhere. */
function readGit(git, repoPath, args, { bytes = false } = {}) {
  const [command, ...prefix] = git;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const result = spawnSync(command, [...prefix, '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repoPath, ...args], {
    encoding: bytes ? 'buffer' : 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? (bytes ? Buffer.alloc(0) : '') };
}

const typeOf = (path) => TYPES[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''] ?? null;

/**
 * The servable files of the checked commit `sha`: its first PREVIEW_ENTRIES page and, under that page's folder, every
 * regular file of a known type that is not hidden, secret-like or too large, keyed by its path inside that folder.
 * Throws PreviewError PREVIEW_COMMIT_MISSING or PREVIEW_NO_PAGE.
 */
export function previewManifest({ git = ['git'], repoPath, sha }) {
  if (!SHA.test(sha ?? '') || !repoPath) throw new PreviewError('PREVIEW_COMMIT_MISSING', 'AIWorks does not have this checked version on this computer.');
  if (!readGit(git, repoPath, ['cat-file', '-e', `${sha}^{commit}`]).ok) throw new PreviewError('PREVIEW_COMMIT_MISSING', 'AIWorks does not have this checked version on this computer.');
  const listed = readGit(git, repoPath, ['ls-tree', '-r', '-l', '-z', '--full-tree', sha]);
  if (!listed.ok) throw new PreviewError('PREVIEW_COMMIT_MISSING', 'AIWorks could not read this checked version.');
  const tree = new Map();
  for (const line of listed.stdout.split('\0')) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t(.+)$/s.exec(line);
    // Regular files only: a link (120000) could name a path outside the folder, and a submodule (160000) has no bytes here.
    if (match && match[2] === 'blob' && ['100644', '100755'].includes(match[1])) tree.set(match[5], { blob: match[3], size: Number(match[4]) });
  }
  const entry = PREVIEW_ENTRIES.find((path) => tree.has(path));
  if (!entry && SERVER_MARKERS.some((path) => tree.has(path))) throw new PreviewError('PREVIEW_NEEDS_SERVER', `This checked version has no static web page, and it looks like an app that runs its own server. ${PREVIEW_RUNTIMES.server.reason}`);
  if (!entry) throw new PreviewError('PREVIEW_NO_PAGE', `This checked version has no web page to preview (AIWorks looks for ${PREVIEW_ENTRIES.join(', ')}).`);
  const root = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
  const files = new Map();
  for (const [path, file] of tree) {
    if (!path.startsWith(root) || files.size >= MAX_FILES) continue;
    const inside = path.slice(root.length);
    if (inside.split('/').some((part) => part.startsWith('.')) || SECRET_NAME.test(inside) || !typeOf(inside) || file.size > MAX_FILE_BYTES) continue;
    files.set(inside, file);
  }
  return { entry: entry.slice(root.length), root, files };
}

/**
 * The file a preview request names inside the served folder, or null. Each segment is decoded once and must be a plain
 * name: no `.` or `..`, no slash, backslash, colon or control character inside it, so nothing reaches outside the folder.
 * A request for a folder reads its index.html.
 */
export function previewFile(manifest, requestPath) {
  const raw = String(requestPath ?? '');
  const parts = raw === '' || raw.endsWith('/') ? [...raw.split('/').slice(0, -1), 'index.html'] : raw.split('/');
  const names = [];
  for (const part of parts) {
    let name;
    try { name = decodeURIComponent(part); } catch { return null; }
    if (!name || name === '.' || name === '..' || /[/\\:\u0000-\u001f\u007f]/.test(name)) return null;
    names.push(name);
  }
  const path = names.join('/');
  const file = manifest.files.get(path);
  return file ? { path, ...file, type: typeOf(path) } : null;
}

/** The bytes of one served file, or null when they cannot be read or a text file looks like it holds a credential. */
export function readPreviewFile({ git = ['git'], repoPath, file }) {
  const read = readGit(git, repoPath, ['cat-file', 'blob', file.blob], { bytes: true });
  if (!read.ok || read.stdout.length > MAX_FILE_BYTES) return null;
  if (TEXT.test(file.type) && containsSecret(read.stdout.toString('utf8'))) return null;
  return read.stdout;
}

/** One request for a file of `source` ({ git, repoPath, sha, manifest }): { status, body, type }. */
export function servePreviewFile(source, requestPath) {
  const file = previewFile(source.manifest, requestPath);
  const bytes = file ? readPreviewFile({ git: source.git, repoPath: source.repoPath, file }) : null;
  return bytes ? { status: 200, body: bytes, type: file.type, sha: source.sha } : { status: 404, body: 'Not in this preview.', type: 'text/plain; charset=utf-8' };
}

/**
 * The dashboard's open previews, in memory only: each is a random token bound to one checked commit, the checkout it is
 * read from and its manifest. Nothing is written; a preview ends after PREVIEW_TTL_MS, the oldest ends when more than
 * MAX_PREVIEWS are open, and one ends as soon as `stillValid(binding)` says its version is no longer the checked one
 * (reopened, sent back for changes, or checked again at another head), checked at most every RECHECK_MS.
 */
export class PreviewSessions {
  constructor({ now = () => Date.now(), stillValid = () => true } = {}) { this.now = now; this.stillValid = stillValid; this.open = new Map(); }

  add({ git, repoPath, sha, manifest, binding }) {
    this.sweep();
    while (this.open.size >= MAX_PREVIEWS) this.open.delete(this.open.keys().next().value);
    const token = randomBytes(16).toString('hex'), expiresAt = this.now() + PREVIEW_TTL_MS;
    this.open.set(token, { git, repoPath, sha, manifest, binding, expiresAt, checkedAt: this.now() });
    return { token, expiresAt };
  }

  sweep() { for (const [token, session] of this.open) if (session.expiresAt <= this.now()) this.open.delete(token); }

  /** The live preview of `token` whose version is still the checked one, or null (and it ends). */
  live(token) {
    this.sweep();
    const session = /^[0-9a-f]{32}$/.test(token ?? '') ? this.open.get(token) : null;
    if (!session) return null;
    if (this.now() - session.checkedAt >= RECHECK_MS) {
      let valid = false;
      try { valid = this.stillValid(session.binding) === true; } catch { valid = false; }
      if (!valid) { this.open.delete(token); return null; }
      session.checkedAt = this.now();
    }
    return session;
  }

  /** One request under /preview/<token>/: { status, body, type }. Only a live preview's served files answer 200. */
  serve(token, requestPath) {
    const session = this.live(token);
    if (!session) return { status: 410, body: 'This preview has ended. Open it again from Review.', type: 'text/plain; charset=utf-8' };
    return servePreviewFile(session, requestPath);
  }
}
