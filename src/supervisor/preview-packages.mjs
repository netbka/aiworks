// Locked dependencies of a server preview (preview-server.mjs, aiworks#39). A checked Node version whose package.json
// declares dependencies is previewed only when the same commit carries the npm lockfile that pins every one of them, and
// AIWorks places each locked package itself, without npm and without running any script:
// - identity: the lockfile (package-lock.json or npm-shrinkwrap.json, version 2 or 3) is read from the checked commit's
//   Git objects next to its package.json, and must list exactly the dependencies that package.json declares; each
//   package it places is pinned there by name, version and sha512 integrity, so the dependencies are bound to the checked
//   source like its own files;
// - artifacts: the bytes come only from a content-addressed npm cache on this computer (npm's own, or the folder the
//   operator names as `previews.packageCache`), found by that integrity and hashed again as they are read, so a missing,
//   stale or altered copy refuses the version. Nothing is downloaded, and no installed node_modules folder is copied;
// - extraction: each tarball is unpacked in memory into the preview's own folder at the lockfile's path. Only plain files
//   and folders are written, each once and inside its package: links, devices, `..`, absolute or Windows-unsafe names
//   and a package's own node_modules refuse the version; hidden and secret-like names are left out, as for the source;
//   and the package.json it carries must name the locked package and version;
// - what is not supported, and refused in the owner's words: a package that needs its install script (`hasInstallScript`,
//   which is also how native addons are built), linked, workspace, bundled, Git or local packages, and a version
//   without a lockfile or with one that no longer matches its package.json. Development dependencies are left out, and an
//   optional one for another platform is skipped as npm skips it. A package's own scripts never run, and at run time the
//   server stays under preview-server.mjs containment: no child processes, native addons or files outside its folder.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { containsSecret } from './coordinator.mjs';
import { PreviewError, readGit, SECRET_NAME } from './preview.mjs';

/** At most this many locked packages, and this many bytes of tarballs, files and unpacked files, per preview. */
export const MAX_PACKAGES = 2000;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_FILES = 50_000;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_LOCK_BYTES = 32 * 1024 * 1024;
const LOCKFILES = Object.freeze(['npm-shrinkwrap.json', 'package-lock.json']);
const DEPENDENCY_FIELDS = Object.freeze(['dependencies', 'optionalDependencies', 'peerDependencies']);
const NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;
// A registry address carrying its own user name or password.
const URL_CREDENTIAL = /[a-z][a-z0-9+.-]*:\/\/[^/@\s"]+@/i;
const LOCKED_PATH = /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/;
const INTEGRITY = /^sha512-([A-Za-z0-9+/]{86}==)$/;
// Names Windows cannot hold as written (as preview-server.mjs refuses them for the source).
const WINDOWS_UNSAFE = /[<>:"\\|?*\u0000-\u001f]|[. ]$|^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const refuse = (code, message) => { throw new PreviewError(code, message); };
const UNSUPPORTED = (what) => refuse('PREVIEW_DEPENDENCY_UNSUPPORTED', `This checked version locks ${what}, which AIWorks does not prepare for a preview, so nothing was started.`);
const UNSAFE = () => refuse('PREVIEW_DEPENDENCY_UNSAFE', 'A dependency of this checked version holds a link, a name outside its folder or a name this computer cannot hold, so nothing was started.');
const TAMPERED = () => refuse('PREVIEW_DEPENDENCY_TAMPERED', 'A dependency prepared on this computer does not match what this checked version’s lockfile pins, so nothing was started.');

/** The npm cache a preview reads locked packages from: the operator's `previews.packageCache`, else npm's own. */
export function packageCacheOf(config) {
  const named = config?.previews?.packageCache;
  if (named !== undefined) return typeof named === 'string' && isAbsolute(named) ? named : null;
  const local = process.platform === 'win32' ? process.env.LOCALAPPDATA : null;
  return local ? join(local, 'npm-cache') : join(homedir(), '.npm');
}

/** Where npm's content-addressed cache keeps the tarball of `integrity` (cacache content-v2). */
export function cachedTarball(cache, integrity) {
  const hex = Buffer.from(INTEGRITY.exec(integrity)[1], 'base64').toString('hex');
  return join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

const sorted = (value) => JSON.stringify(Object.entries(plainObject(value) ? value : {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const matches = (allowed, actual) => !Array.isArray(allowed) || !allowed.length ||
  !allowed.includes(`!${actual}`) && (allowed.every((each) => String(each).startsWith('!')) || allowed.includes(actual));

/** Whether package.json `manifest` declares anything an install would add. */
export function declaresDependencies(manifest) {
  return [...DEPENDENCY_FIELDS, 'bundleDependencies', 'bundledDependencies'].some((name) =>
    Object.keys(plainObject(manifest[name]) ? manifest[name] : Array.isArray(manifest[name]) ? manifest[name] : {}).length > 0);
}

/**
 * The locked packages to place for the package.json `manifest` in the checked commit's folder `folder` ('' or ending in
 * '/'), from the lockfile beside it in `tree`: [{ dir, name, version, integrity, tarball }], `dir` repository-relative.
 * Throws PreviewError when the version cannot be prepared as locked.
 */
export function lockedPackages({ git, repoPath, tree, folder, manifest, cache }) {
  const lockPath = LOCKFILES.map((name) => folder + name).find((path) => tree.has(path));
  if (!lockPath) refuse('PREVIEW_SERVER_NEEDS_INSTALL', 'This checked version declares dependencies without an npm lockfile that pins them, and AIWorks never installs them for a preview, so nothing was started.');
  if (['bundleDependencies', 'bundledDependencies'].some((name) => manifest[name] !== undefined && manifest[name] !== false)) UNSUPPORTED('bundled dependencies');
  if ([...tree.keys()].some((path) => path.startsWith(`${folder}node_modules/`))) UNSUPPORTED('dependencies and also carries its own node_modules folder');
  const file = tree.get(lockPath), read = file.size <= MAX_LOCK_BYTES ? readGit(git, repoPath, ['cat-file', 'blob', file.blob]) : { ok: false };
  let lock = null;
  try { lock = read.ok ? JSON.parse(read.stdout) : null; } catch { lock = null; }
  if (!plainObject(lock) || ![2, 3].includes(lock.lockfileVersion) || !plainObject(lock.packages)) refuse('PREVIEW_SERVER_NEEDS_INSTALL', 'This checked version’s npm lockfile could not be read as a current lockfile, so nothing was started.');
  if (containsSecret(read.stdout) || URL_CREDENTIAL.test(read.stdout)) refuse('PREVIEW_DEPENDENCY_SECRET', 'This checked version’s npm lockfile holds what looks like a credential, so nothing was started.');
  const root = lock.packages[''];
  if (!plainObject(root) || DEPENDENCY_FIELDS.some((name) => sorted(root[name]) !== sorted(manifest[name]))) {
    refuse('PREVIEW_DEPENDENCY_STALE', 'This checked version’s npm lockfile does not match the dependencies its package.json declares, so nothing was started.');
  }
  if (!cache) refuse('PREVIEW_DEPENDENCY_MISSING', 'The folder AIWorks’s settings name for prepared dependencies (previews.packageCache) is not an absolute path, so nothing was started.');
  const packages = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') continue;
    if (!plainObject(entry)) UNSAFE();
    if (entry.dev === true) continue;
    if (!LOCKED_PATH.test(path)) entry.link ? UNSUPPORTED('a linked or workspace package') : UNSAFE();
    const names = path.split('/node_modules/').map((part) => part.replace(/^node_modules\//, ''));
    if (names.some((name) => !NAME.test(name) || name.split('/').some((part) => WINDOWS_UNSAFE.test(part)))) UNSAFE();
    if (entry.link || entry.inBundle) UNSUPPORTED('a linked, workspace or bundled package');
    if ((entry.optional || entry.devOptional) && (!matches(entry.os, process.platform) || !matches(entry.cpu, process.arch))) continue;
    if (entry.hasInstallScript) refuse('PREVIEW_DEPENDENCY_SCRIPT', 'A dependency of this checked version needs its install script run, and AIWorks never runs one for a preview, so nothing was started.');
    if (typeof entry.integrity !== 'string' || !INTEGRITY.test(entry.integrity) || typeof entry.version !== 'string' || !entry.version) {
      UNSUPPORTED('a package without a published version and sha512 integrity (a Git, local or unpinned package)');
    }
    const name = entry.name ?? names.at(-1);
    if (typeof name !== 'string' || !NAME.test(name)) UNSAFE();
    packages.push({ dir: folder + path, name, version: entry.version, integrity: entry.integrity, tarball: cachedTarball(cache, entry.integrity) });
    if (packages.length > MAX_PACKAGES) refuse('PREVIEW_SERVER_TOO_LARGE', 'This checked version locks too many dependencies for a preview, so it was not started.');
  }
  for (const each of packages) {
    let stat = null;
    try { stat = lstatSync(each.tarball); } catch { stat = null; }
    if (!stat?.isFile()) refuse('PREVIEW_DEPENDENCY_MISSING', 'A dependency this checked version locks has not been prepared on this computer (it is not in the npm cache AIWorks reads), so nothing was started.');
  }
  return packages;
}

const text = (block, at, length) => { const raw = block.subarray(at, at + length), end = raw.indexOf(0); return (end < 0 ? raw : raw.subarray(0, end)).toString('utf8'); };
const octal = (block, at, length) => { const raw = text(block, at, length).trim(); return /^[0-7]+$/.test(raw) ? parseInt(raw, 8) : NaN; };

/** The pax header records of `body`: { path, size } where given. */
function paxRecords(body) {
  const found = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at), length = Number(body.subarray(at, space).toString('latin1'));
    if (space < 0 || !Number.isSafeInteger(length) || length <= space - at || at + length > body.length) UNSAFE();
    const record = body.subarray(space + 1, at + length - 1).toString('utf8'), equals = record.indexOf('=');
    if (equals > 0) found[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return found;
}

/**
 * The regular files of one npm tarball `bytes` (gzip'd tar), by path inside its package (the tarball's first folder
 * removed): Map of path to Buffer. Throws PreviewError on anything but plain files and folders, or an unsafe name.
 */
export function tarballFiles(bytes) {
  let tar;
  try { tar = gunzipSync(bytes, { maxOutputLength: MAX_PACKAGE_BYTES }); } catch { TAMPERED(); }
  const files = new Map();
  let at = 0, longName = null, pax = {};
  while (at + 512 <= tar.length) {
    const block = tar.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = Number(pax.size ?? octal(block, 124, 12)), type = String.fromCharCode(block[156] || 0x30);
    if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length) UNSAFE();
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = paxRecords(body); continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = text(body, 0, body.length); continue; }
    const prefix = text(block, 345, 155), raw = pax.path ?? longName ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
    longName = null; pax = {};
    if (type === '5') continue;
    if (!['0', '7'].includes(type)) UNSAFE();
    const parts = raw.split('/').filter((part, index, all) => part !== '' || index < all.length - 1).slice(1);
    if (!parts.length || raw.startsWith('/') || parts.some((part) => !part || part === '.' || part === '..' || WINDOWS_UNSAFE.test(part)) ||
        parts.includes('node_modules')) UNSAFE();
    const path = parts.join('/');
    if (parts.some((part) => part.startsWith('.')) || SECRET_NAME.test(path)) continue;
    if (files.has(path)) UNSAFE();
    files.set(path, body);
    if (files.size > MAX_PACKAGE_FILES) refuse('PREVIEW_SERVER_TOO_LARGE', 'This checked version’s dependencies are too large for a preview, so it was not started.');
  }
  return files;
}

/**
 * Write each locked package (lockedPackages) into `appDir`, from its cached tarball hashed again as it is read, each
 * file exactly once and inside its package's folder. Throws PreviewError when a copy is missing, altered, substituted or
 * unsafe.
 */
export function materializePackages(packages, appDir) {
  const root = resolve(appDir);
  let files = 0, bytes = 0;
  for (const each of packages) {
    let tarball = null;
    try { if (lstatSync(each.tarball).isFile()) tarball = readFileSync(each.tarball); } catch { tarball = null; }
    if (!tarball) refuse('PREVIEW_DEPENDENCY_MISSING', 'A dependency this checked version locks has not been prepared on this computer (it is not in the npm cache AIWorks reads), so nothing was started.');
    if (tarball.length > MAX_TARBALL_BYTES || `sha512-${createHash('sha512').update(tarball).digest('base64')}` !== each.integrity) TAMPERED();
    const unpacked = tarballFiles(tarball);
    let manifest = null;
    try { manifest = JSON.parse(unpacked.get('package.json')?.toString('utf8') ?? ''); } catch { manifest = null; }
    if (manifest?.name !== each.name || manifest?.version !== each.version) TAMPERED();
    const folder = resolve(root, ...each.dir.split('/'));
    if (!folder.startsWith(root + sep)) UNSAFE();
    for (const [path, body] of unpacked) {
      const target = resolve(folder, ...path.split('/'));
      if (!target.startsWith(folder + sep)) UNSAFE();
      files += 1; bytes += body.length;
      if (files > MAX_PACKAGE_FILES || bytes > MAX_PACKAGE_BYTES) refuse('PREVIEW_SERVER_TOO_LARGE', 'This checked version’s dependencies are too large for a preview, so it was not started.');
      mkdirSync(dirname(target), { recursive: true });
      // `wx`: a name another file already holds (case, or another package's folder) refuses the version.
      try { writeFileSync(target, body, { flag: 'wx' }); } catch { UNSAFE(); }
    }
  }
}
