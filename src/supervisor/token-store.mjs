// Operator secret tokens by reference, outside the release credential (docs/SUPERVISOR.md section 16). The external
// campaign API's bearer token lives in the operator's own secret store and is named by reference only; this module reads
// and writes it. It never touches release/credential.mjs, whose reader stays reserved to the release runner's own
// process (tests/supervisor/release-boundary.test.mjs): the two are unrelated secrets that happen to use the same kinds
// of store.
// A store is { has(ref) -> boolean, get(ref) -> string | null, set(ref, value) -> void }; a throw means "cannot tell",
// never "absent". A value reaches a child process over stdin only, never argv or script text, and leaves this module
// only as `get`'s return value: never logged, journalled or written to disk by it.
// Stores: the Windows Credential Manager (the default), a credential helper command the operator configures, or a plain
// `.env` file ({ kind: 'env-file', path }) whose keys are envKey(reference). The file is read here only;
// its values never enter process.env.
// Tests use a synthetic helper with a synthetic value; no test reads the real store.
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
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

const checkedEnvPath = (path) => {
  if (typeof path !== 'string' || !path.length || !isAbsolute(path)) throw new TypeError('an env-file store needs an absolute path');
  return path;
};

/** The env-file key of a reference: uppercased, every other character an underscore (`aiworks-alerts/bot` -> `AIWORKS_ALERTS_BOT`). */
export const envKey = (ref) => checkedRef(ref).toUpperCase().replace(/[^A-Z0-9]/g, '_');

const AMBIGUOUS = Symbol('ambiguous');

/**
 * Parse env-file text into Map(reference -> value | AMBIGUOUS). Blank lines, `#` comments and lines whose key is not a
 * valid reference are ignored; `export ` is allowed; one pair of matching quotes around the value is stripped, with no
 * escapes and no interpolation; a key defined twice is AMBIGUOUS.
 */
function parseEnv(text) {
  const entries = new Map();
  for (const raw of text.split('\n')) {
    const entry = envLine(raw);
    if (!entry) continue;
    entries.set(entry.key, entries.has(entry.key) ? AMBIGUOUS : entry.value);
  }
  return entries;
}

function envLine(raw) {
  const line = raw.replace(/\r$/, '').trim();
  if (!line || line.startsWith('#')) return null;
  const body = line.replace(/^export\s+/, '');
  const at = body.indexOf('=');
  if (at < 1) return null;
  const key = body.slice(0, at).trim();
  if (!/^[A-Z0-9_]+$/.test(key)) return null;
  let value = body.slice(at + 1).trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
  return { key, value };
}

function envLookup(entries, ref) {
  const value = entries.get(envKey(ref));
  if (value === AMBIGUOUS) throw new Error('the env file defines this reference more than once');
  return value === undefined ? null : value;
}

function envText(read, path) {
  try { return read(path); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`the env file could not be read (${error?.code ?? 'error'})`);
  }
}

function envWritten(value) {
  checkedValue(value);
  if (/[\r\n]/.test(value)) throw new TypeError('a token value must not contain a line break');
  if (!/[#"']/.test(value) && value === value.trim()) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new TypeError('a token value with both quote kinds cannot be stored in an env file');
}

/**
 * A plain env file: `KEY=VALUE` lines whose KEY is envKey(reference). A missing file is absent; any other
 * read error, or a key defined twice, is "cannot tell" (throws). `set` replaces or appends one line, keeps every other
 * line as it was, and writes through a temporary file in the same directory. Values are never put in process.env, logged
 * or placed in an error message. `fs` is injectable for tests.
 */
export function envFileTokenStore(path, { fs: fsImpl = fs } = {}) {
  checkedEnvPath(path);
  const read = () => envText((p) => fsImpl.readFileSync(p, 'utf8'), path);
  const value = (ref) => { const text = read(); return text === null ? null : envLookup(parseEnv(text), ref); };
  return {
    has: (ref) => { const v = value(ref); return v !== null; },
    get: (ref) => value(ref),
    set(ref, secret) {
      const key = envKey(ref);
      const written = envWritten(secret);
      const text = read() ?? '';
      const lines = text.length ? text.split('\n') : [];
      const hits = [];
      lines.forEach((raw, index) => { if (envLine(raw)?.key === key) hits.push(index); });
      if (hits.length > 1) throw new Error('the env file defines this reference more than once');
      if (hits.length === 1) {
        const crlf = lines[hits[0]].endsWith('\r') ? '\r' : '';
        lines[hits[0]] = `${key}=${written}${crlf}`;
      } else {
        if (lines.length && lines.at(-1) === '') lines.pop();
        const crlf = lines.length && lines.at(-1).endsWith('\r') ? '\r' : '';
        lines.push(`${key}=${written}${crlf}`);
      }
      const next = `${lines.join('\n')}\n`;
      const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
      let mode = 0o600;
      try { mode = fsImpl.statSync(path).mode & 0o777; } catch { /* a new file */ }
      try {
        fsImpl.writeFileSync(temp, next, { encoding: 'utf8', mode });
        fsImpl.renameSync(temp, path);
      } catch (error) {
        try { fsImpl.unlinkSync(temp); } catch { /* nothing to remove */ }
        throw new Error(`the env file could not be written (${error?.code ?? 'error'})`);
      }
    },
  };
}

/**
 * The store config names: { kind: 'windows' } (the default), { kind: 'command', command: [...] } or
 * { kind: 'env-file', path: '<absolute path>' }.
 */
export function tokenStoreFrom(spec = { kind: 'windows' }) {
  if (spec?.kind === 'windows') return windowsTokenStore();
  if (spec?.kind === 'command') return commandTokenStore(spec.command);
  if (spec?.kind === 'env-file') return envFileTokenStore(spec.path);
  throw new TypeError(`unknown token store ${JSON.stringify(spec?.kind ?? null)}`);
}

/** A reference's current value, or null when it does not resolve. A store that cannot tell throws. */
export function readToken(store, ref) {
  const value = store.get(checkedRef(ref));
  return typeof value === 'string' && value.length ? value : null;
}

/**
 * The read-only store `spec` names, resolved without blocking the event loop: { get(ref) -> Promise<string | null> },
 * the same `get` contract as windowsTokenStore and commandTokenStore (exit 3 or 1 absent, any other exit "cannot tell",
 * which rejects). For a caller that runs beside the controller tick (check-service-caller.mjs). `run` is injectable.
 */
export function asyncTokenReader(spec = { kind: 'windows' }, { run = execFile } = {}) {
  const call = (file, args, absentExit) => new Promise((done, fail) => {
    run(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (error, stdout) => {
      const status = error ? (Number.isInteger(error.code) ? error.code : -1) : 0;
      if (status === absentExit) done(null);
      else if (status !== 0) fail(new Error(`the credential store could not answer get (exit ${status})`));
      else done(String(stdout ?? ''));
    });
  });
  if (spec?.kind === 'windows') {
    return { get: (ref) => {
      checkedRef(ref);
      if (!POWERSHELL) return Promise.reject(new Error('the Windows Credential Manager exists only on Windows'));
      return call(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script('get', ref), 'utf16le').toString('base64')], 3);
    } };
  }
  if (spec?.kind === 'command') {
    const command = spec.command;
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part)) {
      throw new TypeError('a credential helper is a non-empty command array');
    }
    return { get: async (ref) => {
      const value = await call(command[0], [...command.slice(1), 'get', checkedRef(ref)], 1);
      return value === null ? null : value.replace(/\r?\n$/, '');
    } };
  }
  if (spec?.kind === 'env-file') {
    const path = checkedEnvPath(spec.path);
    return { get: async (ref) => {
      envKey(ref);
      let text;
      try { text = await fsp.readFile(path, 'utf8'); } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw new Error(`the env file could not be read (${error?.code ?? 'error'})`);
      }
      return envLookup(parseEnv(text), ref);
    } };
  }
  throw new TypeError(`unknown token store ${JSON.stringify(spec?.kind ?? null)}`);
}
