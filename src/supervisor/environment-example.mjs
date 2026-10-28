// A narrowly recognized source template, never a live environment file. Values
// must be empty, references to environment variables, or explicit placeholders.
import { SECRET_LIKE_PATH_PATTERN } from '../../scripts/lib/worker-context.mjs';
import { contentFindings } from '../shared/public-text.mjs';
import { containsCredentialMaterial } from '../shared/credential-metadata.mjs';

const secretPath = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');
export function environmentExamplePath(path) {
  if (typeof path !== 'string' || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const parts = String(path).replaceAll('\\', '/').split('/');
  return parts.pop() === '.env.example' && !parts.some((part) => !part || part === '..' || part === '.') &&
    !secretPath.test(parts.join('/'));
}

export function safeEnvironmentExample(path, content) {
  if (!environmentExamplePath(path) || typeof content !== 'string' || Buffer.byteLength(content) > 65536 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content) || contentFindings(content).length) return false;
  return content.split(/\r?\n/).every((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    const comment = trimmed.startsWith('#');
    const text = comment ? trimmed.replace(/^#+\s*/, '') : trimmed;
    const assignment = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(text);
    // Commented assignments obey the same grammar. Other comments may explain
    // setup, but cannot carry credential headers, assignments or URL parameters.
    if (!assignment) return comment && !containsCredentialMaterial(text);
    let value = assignment[1];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value === '' || /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|<required>|<optional>|REPLACE_ME|CHANGEME)$/.test(value);
  });
}
