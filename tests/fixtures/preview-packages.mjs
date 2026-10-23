// Synthetic npm packages for server preview tests: tarballs built here, placed in a disposable content-addressed npm
// cache, and the lockfile entries that pin them. Nothing is downloaded and no real cache is read.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { cachedTarball } from '../../src/supervisor/preview-packages.mjs';

function header(name, size, type, linkname = '') {
  const block = Buffer.alloc(512);
  const put = (text, at, length) => block.write(text, at, length, 'utf8');
  put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
  put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12); put(`${'0'.repeat(11)}\0`, 136, 12); put(' '.repeat(8), 148, 8);
  put(type, 156, 1); put(linkname, 157, 100); put('ustar\0', 257, 6); put('00', 263, 2);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

/** A gzip'd tar of `entries`: { path, body?, type? ('0' file, '2' link, '1' hard link, '5' folder), linkname? }. */
export function tarball(entries) {
  const blocks = [];
  for (const { path, body = '', type = '0', linkname = '' } of entries) {
    const bytes = Buffer.from(body);
    blocks.push(header(path, type === '0' ? bytes.length : 0, type, linkname));
    if (type === '0') blocks.push(bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** A package tarball as npm packs one: its files under `package/`, with a package.json naming it. */
export function packageTarball(name, version, files = {}, extra = []) {
  return tarball([{ path: 'package/package.json', body: JSON.stringify({ name, version, type: 'module', main: 'index.mjs' }) },
    ...Object.entries(files).map(([path, body]) => ({ path: `package/${path}`, body })), ...extra]);
}

export const integrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** Put `bytes` in the npm cache folder `cache` where npm keeps it by its integrity; returns that integrity. */
export function cache(cacheDir, bytes) {
  const integrity = integrityOf(bytes), path = cachedTarball(cacheDir, integrity);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return integrity;
}

/** A version 3 lockfile for package.json `manifest` with `packages` keyed by lockfile path. */
export function lockfile(manifest, packages) {
  const root = Object.fromEntries(['name', 'version', 'dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']
    .filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]));
  return `${JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: { '': root, ...packages } }, null, 2)}\n`;
}

/** The lockfile entry of a published package in the registry of example.invalid. */
export const locked = (name, version, integrity, extra = {}) =>
  ({ version, resolved: `https://registry.example.invalid/${name}/-/${name.split('/').at(-1)}-${version}.tgz`, integrity, ...extra });
