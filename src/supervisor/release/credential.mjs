// The release credential, by reference only (docs/design/AUTO_RELEASE.md section 6, slice REL5). Built switched off:
// no release credential exists until the owner answers netbka/aiworks#33 item 2, and nothing outside the release
// runner fetches one. The rules:
// - a grant names a credential by reference (`destinations[].credential.ref`, for example `aiworks-release/dyk`), never
//   by value. AIWorks stores, logs and journals only that reference;
// - the supervisor may ask whether a reference resolves (eligibility check E12). That question reads presence only and
//   never the value;
// - only the release runner's own process fetches the value, at the moment of its step, for that one command
//   (release/runner.mjs). The value never reaches the supervisor's environment, a worker, disk, SQLite or a packet.
// A store is { has(ref) -> boolean, get(ref) -> string | null }; a throw means "cannot tell", never "absent".
// Stores: the Windows Credential Manager (the design's default, owner question Q2), or a credential helper command the
// owner configures (for example an Infisical wrapper). Tests use a synthetic helper with a synthetic value.
import { spawnSync } from 'node:child_process';
import { POWERSHELL } from '../proc.mjs';

/** A reference: path-like segments of letters, digits, dot, dash and underscore; no quotes, spaces or line breaks. */
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export const validCredentialRef = (ref) => typeof ref === 'string' && ref.length <= 128 && REF.test(ref);

function checkedRef(ref) {
  if (!validCredentialRef(ref)) throw new TypeError('a release credential reference is a short name like aiworks-release/<project>');
  return ref;
}

const READ_SCRIPT = (ref) => `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class AiworksReleaseCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
  public static string Read(string target) {
    IntPtr pointer; if (!CredRead(target, 1, 0, out pointer)) return null;
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      return c.CredentialBlobSize == 0 ? "" : Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); }
    finally { CredFree(pointer); }
  }
}
"@
$value = [AiworksReleaseCredential]::Read('${ref}')
if ($null -eq $value) { exit 3 }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.Write($value)
exit 0`;

/**
 * The Windows Credential Manager, generic credentials named by the reference (`cmdkey /generic:aiworks-release/dyk`).
 * `has` lists the target with cmdkey, which never prints a password. `get` reads it with CredRead in a PowerShell child
 * and is called only by the release runner process. `exec` is injectable for tests; no test reads the real store.
 */
export function windowsCredentialStore({ exec = spawnSync, powershell = POWERSHELL } = {}) {
  const run = (file, args) => exec(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return {
    has(ref) {
      checkedRef(ref);
      if (!powershell) throw new Error('the Windows Credential Manager exists only on Windows');
      const out = run('cmdkey', [`/list:${ref}`]);
      if (out.status !== 0) throw new Error(`cmdkey could not list credentials (exit ${out.status})`);
      const target = ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      return new RegExp(`(?:target=|:\\s)${target}\\s*$`, 'im').test(out.stdout ?? '');
    },
    get(ref) {
      checkedRef(ref);
      if (!powershell) throw new Error('the Windows Credential Manager exists only on Windows');
      const out = run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(READ_SCRIPT(ref), 'utf16le').toString('base64')]);
      if (out.status === 3) return null;
      if (out.status !== 0) throw new Error(`the Windows Credential Manager could not be read (exit ${out.status})`);
      return out.stdout;
    },
  };
}

/**
 * A credential helper command the owner configures: `<command...> has <ref>` exits 0 when present, 1 when absent;
 * `<command...> get <ref>` prints the value and exits 0, or exits 1 when absent. Any other exit is "cannot tell".
 */
export function commandCredentialStore(command, { exec = spawnSync } = {}) {
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part)) {
    throw new TypeError('a credential helper is a non-empty command array');
  }
  const run = (op, ref) => exec(command[0], [...command.slice(1), op, checkedRef(ref)], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const absent = (out, op) => {
    if (out.status === 1) return true;
    if (out.status !== 0) throw new Error(`the credential helper could not answer ${op} (exit ${out.status})`);
    return false;
  };
  return {
    has: (ref) => !absent(run('has', ref), 'has'),
    get(ref) {
      const out = run('get', ref);
      return absent(out, 'get') ? null : String(out.stdout ?? '').replace(/\r?\n$/, '');
    },
  };
}

/** The store a packet or config names: { kind: 'windows' } (the default) or { kind: 'command', command: [...] }. */
export function credentialStoreFrom(spec = { kind: 'windows' }) {
  if (spec?.kind === 'windows') return windowsCredentialStore();
  if (spec?.kind === 'command') return commandCredentialStore(spec.command);
  throw new TypeError(`unknown release credential store ${JSON.stringify(spec?.kind ?? null)}`);
}

/** Whether a reference resolves: presence only, the value is never read. A store that cannot tell throws. */
export const credentialResolves = (store, ref) => validCredentialRef(ref) && store.has(ref) === true;

/**
 * Fetch the value for one reference. Only the release runner's own process calls this, at the moment of its step.
 * Returns null when the reference does not resolve. The value is returned to the caller only: never logged or stored.
 */
export function fetchCredential(store, ref) {
  const value = store.get(checkedRef(ref));
  return typeof value === 'string' && value.length ? value : null;
}

/**
 * The `role` reader of eligibility check E12 (release/eligibility.mjs): { installed, credentialResolves } for one
 * candidate. `refFor(candidate)` names the destination's credential reference from its grant; none means it does not
 * resolve. A store that throws makes the reader throw, which E12 reports as unreadable: never "present".
 */
export function releaseRoleReader({ store, refFor, installed = true }) {
  return (candidate) => {
    const ref = refFor?.(candidate) ?? null;
    return { installed: installed === true, credentialResolves: ref !== null && credentialResolves(store, ref) };
  };
}
