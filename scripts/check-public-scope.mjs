// Inspect staged bytes: an edited working copy cannot conceal a staged disclosure.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { containsKnownSecretValue } from '../src/shared/credential-metadata.mjs';

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

function privateTerms(root) {
  try {
    const value = JSON.parse(readFileSync(resolve(root, '.local/publication.json'), 'utf8'));
    if (!Array.isArray(value.privateTerms) || !value.privateTerms.every(term => typeof term === 'string' && term.trim().length >= 3)) throw new Error();
    return value.privateTerms;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Invalid private publication settings in .local/publication.json.');
  }
}

export function contentFindings(text, terms = []) {
  const findings = [];
  if (containsKnownSecretValue(text) || /(?:https?|postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s/@:]+:[^\s/@]+@/i.test(text) ||
      /\b(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\b["']?\s*[:=]\s*["'][A-Za-z0-9_+\/=-]{16,}["']/i.test(text)) findings.push('credential material');
  if (/\bnetbka\/(?!aiworks(?:\.git)?(?![\w.-]))[\w.-]+/i.test(text)) findings.push('another upstream-owner project');
  if (/[A-Z]:[\\/]+(?:Users|Git)[\\/]+[\w.-]+/i.test(text) || /\/home\/(?!example\b|user\b)[\w.-]+/i.test(text)) findings.push('personal installation path');
  if (terms.some(term => text.toLowerCase().includes(term.toLowerCase()))) findings.push('private installation reference');
  return findings;
}

function inspect(root, entries, terms) {
  if (privatePaths(entries.map(entry => entry.path)).length) throw new Error('Private installation files are in the Git index or proposed history. Keep installation data under ignored .local/.');
  if (entries.some(entry => !['100644', '100755'].includes(entry.mode))) throw new Error('Public source must not contain symlinks, submodules or unresolved index entries.');
  if (!entries.length) return;
  const bytes = git(root, ['cat-file', '--batch'], entries.map(entry => entry.oid).join('\n') + '\n');
  let offset = 0, failures = 0;
  for (const entry of entries) {
    const end = bytes.indexOf(10, offset);
    const [oid, type, size] = bytes.subarray(offset, end).toString().split(' ');
    if (oid !== entry.oid || type !== 'blob' || !/^\d+$/.test(size)) throw new Error('Cannot inspect a public source blob.');
    const source = bytes.subarray(end + 1, end + 1 + Number(size)).toString('utf8');
    offset = end + 2 + Number(size);
    failures += contentFindings(source, terms).length + contentFindings(entry.path, terms).length;
  }
  // Diagnostics must not republish matched values, private filenames or commit messages.
  if (failures) throw new Error(`Public content check failed (${failures} findings). Inspect staged content locally for credentials, private project references and personal paths. No matched values are printed.`);
}

export function checkPublicScope(root = process.cwd()) {
  const entries = git(root, ['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), path = line.slice(tab + 1);
    const [mode, oid, stage] = line.slice(0, tab).split(' ');
    return { mode: stage === '0' ? mode : 'unmerged', oid, path };
  });
  inspect(root, entries, privateTerms(root));
}

export function checkPublicHistory(root, revisions) {
  const terms = privateTerms(root);
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
    inspect(root, entries, terms);
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
