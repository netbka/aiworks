// Operator secret tokens by reference, outside the release credential (docs/SUPERVISOR.md section 16). The external
// campaign API's bearer token lives in the operator's own secret store and is named by reference only; this module reads
// and writes it. It never touches release/credential.mjs, whose reader stays reserved to the release runner's own
// process (tests/supervisor/release-boundary.test.mjs): the two are unrelated secrets that happen to use the same kinds
// of store.
// A store is { has(ref) -> boolean, get(ref) -> string | null, set(ref, value) -> void }; a throw means "cannot tell",
// never "absent". A value reaches a child process over stdin only, never argv or script text, and leaves this module
// only as `get`'s return value: never logged, journalled or written to disk by it.
// Stores: the Windows Credential Manager (the default), or a credential helper command the operator configures.
// Tests use a synthetic helper with a synthetic value; no test reads the real store.
import { spawnSync } from 'node:child_process';
import { POWERSHELL } from './proc.mjs';

/** A reference: segments of letters, digits, dot, dash and underscore joined by `/` or `:`
 * (`aiworks-campaign-api:<projectId>`); no quotes, spaces or line breaks, so it is safe inside a single-quoted script. */
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]*([/:][A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export const validTokenRef = (ref) => typeof ref === 'string' && ref.length <= 128 && REF.test(ref);

function checkedRef(ref) {
  if (!validTokenRef(ref)) throw new TypeError('a token reference is a short name like aiworks-campaign-api:<project>');
  return ref;
}

function checkedValue(value) {
  if (typeof value !== 'string' || !value.length) throw new TypeError('a token value must be a non-empty string');
  return value;
}

const CREDENTIAL_TYPE = `using System; using System.Runtime.InteropServices;
public static class AiworksTokenStore {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWrite(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
  public static string Read(string target) {
    IntPtr pointer; if (!CredRead(target, 1, 0, out pointer)) return null;
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      return c.CredentialBlobSize == 0 ? "" : Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); }
    finally { CredFree(pointer); }
  }
  public static void Write(string target, string secret) {
    byte[] bytes = System.Text.Encoding.Unicode.GetBytes(secret);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL cred = new CREDENTIAL();
      cred.Type = 1; cred.TargetName = target; cred.CredentialBlobSize = bytes.Length; cred.CredentialBlob = blob; cred.Persist = 2; cred.UserName = "aiworks";
      if (!CredWrite(ref cred, 0)) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(blob); }
  }
}`;

// `has` exits 0 or 3 and prints nothing; `get` prints the value; `set` reads the value from stdin. The reference is the
// only data embedded in the script, and checkedRef admits no quote.
const SCRIPTS = {
  has: (ref) => `$value = [AiworksTokenStore]::Read('${ref}')
if ($null -eq $value) { exit 3 }
exit 0`,
  get: (ref) => `$value = [AiworksTokenStore]::Read('${ref}')
if ($null -eq $value) { exit 3 }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.Write($value)
exit 0`,
  set: (ref) => `[Console]::InputEncoding = [Text.Encoding]::UTF8
$value = [Console]::In.ReadToEnd()
if ($value.Length -eq 0) { exit 4 }
[AiworksTokenStore]::Write('${ref}', $value)
exit 0`,
};
const script = (op, ref) => `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
${CREDENTIAL_TYPE}
"@
${SCRIPTS[op](ref)}`;

/**
 * The Windows Credential Manager, generic credentials named by the reference. Every operation runs CredRead or
 * CredWrite in a hidden PowerShell child; `has` never prints the value and `set` pipes it over stdin. `exec` is
 * injectable for tests.
 */
export function windowsTokenStore({ exec = spawnSync, powershell = POWERSHELL } = {}) {
  const run = (op, ref, input) => {
    checkedRef(ref);
    if (!powershell) throw new Error('the Windows Credential Manager exists only on Windows');
    return exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script(op, ref), 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000, ...(input === undefined ? {} : { input }) });
  };
  return {
    has(ref) {
      const out = run('has', ref);
      if (out.status === 3) return false;
      if (out.status !== 0) throw new Error(`the Windows Credential Manager could not be read (exit ${out.status})`);
      return true;
    },
    get(ref) {
      const out = run('get', ref);
      if (out.status === 3) return null;
      if (out.status !== 0) throw new Error(`the Windows Credential Manager could not be read (exit ${out.status})`);
      return out.stdout;
    },
    set(ref, value) {
      checkedRef(ref);
      const out = run('set', ref, checkedValue(value));
      if (out.status !== 0) throw new Error(`the Windows Credential Manager could not be written (exit ${out.status})`);
    },
  };
}

/**
 * A credential helper command the operator configures: `<command...> has <ref>` exits 0 when present, 1 when absent;
 * `<command...> get <ref>` prints the value and exits 0, or exits 1 when absent; `<command...> set <ref>` reads the value
 * from stdin and exits 0. Any other exit is "cannot tell". The helper's own output never reaches a message here.
 */
export function commandTokenStore(command, { exec = spawnSync } = {}) {
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part)) {
    throw new TypeError('a credential helper is a non-empty command array');
  }
  const run = (op, ref, input) => exec(command[0], [...command.slice(1), op, checkedRef(ref)],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, ...(input === undefined ? {} : { input }) });
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
    set(ref, value) {
      checkedRef(ref);
      const out = run('set', ref, checkedValue(value));
      if (out.status !== 0) throw new Error(`the credential helper could not set (exit ${out.status})`);
    },
  };
}

/** The store config names: { kind: 'windows' } (the default) or { kind: 'command', command: [...] }. */
export function tokenStoreFrom(spec = { kind: 'windows' }) {
  if (spec?.kind === 'windows') return windowsTokenStore();
  if (spec?.kind === 'command') return commandTokenStore(spec.command);
  throw new TypeError(`unknown token store ${JSON.stringify(spec?.kind ?? null)}`);
}

/** A reference's current value, or null when it does not resolve. A store that cannot tell throws. */
export function readToken(store, ref) {
  const value = store.get(checkedRef(ref));
  return typeof value === 'string' && value.length ? value : null;
}
