// Inspect staged bytes: an edited working copy cannot conceal a staged disclosure.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { contentFindings, privateTerms } from '../src/shared/public-text.mjs';

export { contentFindings };

export function privatePaths(paths) {
  return paths.filter(path => /^(?:campaigns|\.local|runs|backups|state|governance|artifacts|reports|screenshots|registry\/projects)\//i.test(path) ||
    /(?:^|\/)(?:\.claude|\.codex|\.aws|\.ssh|\.gnupg)(?:\/|$)/i.test(path) ||
    /(?:^|\/)(?:config\.json|\.npmrc|\.netrc|(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|ini|txt))?|id_rsa[^/]*|id_ed25519[^/]*)$/i.test(path) ||
    /(?:^|\/)\.env(?:$|\.(?!example$))/i.test(path) ||
    /\.(?:db(?:-wal|-shm)?|sqlite3?|pem|key|pfx|p12|jks|keystore|log)$/i.test(path));
}

function git(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Cannot inspect the public commit scope.');
  return result.stdout;
}

// A screenshot or document carries private data the text checks cannot read. Each binary blob that may be public is
// listed by id in BINARY_LIST after someone looked at it; any other binary blob is refused.
export const BINARY_LIST = '.public-binaries';
const BINARY_PATH = /\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?|heic|svgz|pdf|zip|7z|gz|tgz|bz2|xz|rar|tar|jar|exe|dll|so|dylib|docx?|xlsx?|pptx?|od[tsp]|mp[34]|mov|webm|avi|wav|woff2?|ttf|otf|eot)$/i;

/** The blob ids a list file (the text of BINARY_LIST) allows: the first word of each line that is not a comment. */
export function allowedBinaries(text) {
  return new Set(String(text ?? '').split(/\r?\n/).map(line => line.trim().split(/\s+/)[0]).filter(word => /^[0-9a-f]{40}$/.test(word)));
}

function inspect(root, entries, terms, binaries) {
  if (privatePaths(entries.map(entry => entry.path)).length) throw new Error('Private installation files are in the Git index or proposed history. Keep installation data under ignored .local/.');
  if (entries.some(entry => !['100644', '100755'].includes(entry.mode))) throw new Error('Public source must not contain symlinks, submodules or unresolved index entries.');
  if (!entries.length) return;
  const bytes = git(root, ['cat-file', '--batch'], entries.map(entry => entry.oid).join('\n') + '\n');
  let offset = 0, failures = 0;
  const unlisted = [];
  for (const entry of entries) {
    const end = bytes.indexOf(10, offset);
    const [oid, type, size] = bytes.subarray(offset, end).toString().split(' ');
    if (oid !== entry.oid || type !== 'blob' || !/^\d+$/.test(size)) throw new Error('Cannot inspect a public source blob.');
    const raw = bytes.subarray(end + 1, end + 1 + Number(size));
    offset = end + 2 + Number(size);
    if ((BINARY_PATH.test(entry.path) || raw.subarray(0, 8000).includes(0)) && !binaries.has(oid)) unlisted.push(oid);
    failures += contentFindings(raw.toString('utf8'), terms).length + contentFindings(entry.path, terms).length;
  }
  // Blob ids name no private value, so the refusal can say which ones to look at.
  if (unlisted.length) throw new Error(`Binary files not in ${BINARY_LIST}: ${[...new Set(unlisted)].join(', ')}. Open each one, confirm it shows no private data (people, emails, paths, project names), then add its id with a path to ${BINARY_LIST}.`);
  // Diagnostics must not republish matched values, private filenames or commit messages.
  if (failures) throw new Error(`Public content check failed (${failures} findings). Inspect staged content locally for credentials, private project references and personal paths. No matched values are printed.`);
}

export function checkPublicScope(root = process.cwd()) {
  const entries = git(root, ['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), path = line.slice(tab + 1);
    const [mode, oid, stage] = line.slice(0, tab).split(' ');
    return { mode: stage === '0' ? mode : 'unmerged', oid, path };
  });
  const list = entries.find(entry => entry.path === BINARY_LIST);
  inspect(root, entries, privateTerms(root), allowedBinaries(list ? git(root, ['cat-file', 'blob', list.oid]).toString() : ''));
}

/** Every commit in `revisions` is checked against the binary list of `tip`, the commit being published. */
export function checkPublicHistory(root, revisions, tip = revisions.at(-1).split('..').at(-1)) {
  const terms = privateTerms(root);
  const listed = spawnSync('git', ['cat-file', 'blob', `${tip}:${BINARY_LIST}`], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const binaries = allowedBinaries(listed.status === 0 ? listed.stdout.toString() : '');
  const commits = git(root, ['rev-list', ...revisions]).toString().trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    const message = git(root, ['show', '-s', '--format=%B', commit]).toString();
    let findings = contentFindings(message, terms);
    // GitHub's merge header names a branch, not another repository; every other privacy check still sees the original.
    if (/^Merge pull request #[1-9]\d* from netbka\/[^\s]+\r?\n/.test(message) &&
        git(root, ['show', '-s', '--format=%P', commit]).toString().trim().split(' ').length === 2) {
      const withoutOwner = message.replace(/^(Merge pull request #[1-9]\d* from )netbka\//, '$1');
      if (!contentFindings(withoutOwner).includes('another upstream-owner project')) {
        findings = findings.filter(finding => finding !== 'another upstream-owner project');
      }
    }
    if (findings.length) throw new Error('A proposed commit message contains private information.');
    const entries = git(root, ['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean).map(line => {
      const tab = line.indexOf('\t'), path = line.slice(tab + 1);
      const [mode, , oid] = line.slice(0, tab).split(' ');
      return { mode, oid, path };
    });
    inspect(root, entries, terms, binaries);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--pre-push') {
      for (const line of readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
        const [localRef, local, remoteRef, remote] = line.split(/\s+/);
        if (!/^[0-9a-f]{40}$/.test(local) || !/^[0-9a-f]{40}$/.test(remote)) throw new Error('Invalid push reference.');
        if (/^0+$/.test(local)) continue;
        const terms = privateTerms(process.cwd());
        if (contentFindings(`${localRef}\n${remoteRef}`, terms).length) throw new Error('A proposed branch or tag name contains private information.');
        let object = local;
        while (git(process.cwd(), ['cat-file', '-t', object]).toString().trim() === 'tag') {
          const tag = git(process.cwd(), ['cat-file', '-p', object]).toString();
          if (contentFindings(tag, terms).length) throw new Error('A proposed tag annotation contains private information.');
          object = /^object ([0-9a-f]{40})\n/.exec(tag)?.[1];
          if (!object) throw new Error('Cannot inspect a proposed tag.');
        }
        if (git(process.cwd(), ['cat-file', '-t', object]).toString().trim() !== 'commit') throw new Error('A public branch or tag must resolve to a commit.');
        checkPublicHistory(process.cwd(), /^0+$/.test(remote) ? [local] : [`${remote}..${local}`]);
      }
    } else checkPublicScope();
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
