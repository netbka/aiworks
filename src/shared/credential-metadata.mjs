// Pure metadata checks shared by repository validation and runtime storage.
// Classify only the canonical spelling: casing/separators must never change the
// result. Short words need explicit compounds so keyboard/monkey/design stay safe.
const safeCredentialMetadata = new Set(["maxtokens", "cookiesecure", "tokenendpoint", "passwordlength", "sessiontimeout"]);
const credentialCompound = /(?:^|api|private|access|signing|encryption|service|client|webhook|request|header|x)(?:key|auth|sig)(?:$|value|material|payload|header|content|pem|data|text|encoded|blob|input)/;
const passwordCompound = /^(?:|db|database|smtp|mail|email|user|admin|root|ftp|sftp|redis|mysql|pg|postgres|postgresql|mongo|mongodb|sql|ldap|proxy|basic|app|service)pass(?:value)?$/;

// Well-known credential value formats, recognised whatever key or position they appear under and through
// common encoding layers (N7, historical regression review).
const KNOWN_SECRET_VALUES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/,
  /(?:^|[^A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /(?:^|[^A-Za-z0-9])sk-(?:ant-[a-z0-9]+-|proj-)?[A-Za-z0-9_-]{32,}/,
  /(?:^|[^A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/,
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/,
  /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/,
  /(?:^|[^A-Za-z0-9])npm_[A-Za-z0-9]{36}/,
  /(?:^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/,
  /(?:^|[^0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/, // Telegram bot token, also in /bot<token>/ URLs
  /(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];
const decodingLayers = (value) => {
  const layers = new Set([value, value.replaceAll("+", " ")]);
  for (const layer of [...layers]) {
    try { layers.add(decodeURIComponent(layer)); } catch { /* malformed escapes stay as they are */ }
    try { layers.add(JSON.parse(`"${layer.replace(/(?<!\\)"/g, '\\"')}"`)); } catch { /* not a JSON string body */ }
  }
  for (const layer of [...layers]) {
    if (/^[A-Za-z0-9+/_-]{24,}={0,2}$/.test(layer.trim())) {
      try { layers.add(Buffer.from(layer.trim(), "base64").toString("utf8")); } catch { /* not base64 */ }
    }
  }
  return [...layers];
};
export const containsKnownSecretValue = (value) => typeof value === "string" &&
  decodingLayers(value).some((layer) => KNOWN_SECRET_VALUES.some((pattern) => pattern.test(layer)));

// Cookie and session-id header or variable names name a credential in any case or separator style (Cookie,
// Set-Cookie, SESSION_ID, sessionid, session-token, JSESSIONID, PHPSESSID, sessid, connect.sid). Compared after
// removing separators and case. Keys, declared field names and values that name a secret all use it, so
// short forms without the word "session" (sessid, PHPSESSID, connect.sid) are refused as keys too (historical regression,
// historical regression review).
export const SESSION_CREDENTIAL_NAMES = /^(?:set)?cookie2?$|^(?:x|j|php|asp|aspnet|connect|user|auth|app|web)?sess(?:ion)?(?:id|key|token|cookie|value|secret)$|^connectsid$/;
export const isSecretLikeConfigKey = (name) => {
  const normalized = name.replace(/[_.\s+-]/g, "").toLowerCase();
  if (safeCredentialMetadata.has(normalized)) return false;
  return /secret|token|password|passwd|passphrase|pwd|authorization|authentication|bearer|credential|cookie|session|signature|auth(?:header|value|payload)/.test(normalized) || credentialCompound.test(normalized) ||
    passwordCompound.test(normalized) || SESSION_CREDENTIAL_NAMES.test(normalized);
};
// One decoding layer, before WHATWG's forgiving decoder can erase malformed
// escapes. Only plain-text numeric percentages (100%, 100% complete) are literal.
const decodeMetadata = (text, literalPercent = false) => {
  try {
    if (!literalPercent) return decodeURIComponent(text);
    for (const match of text.matchAll(/%(?![0-9a-f]{2})/gi)) {
      if (!/[0-9]/.test(text[match.index - 1] ?? "") || !/^(?:$|[\s.,;!?])/.test(text.slice(match.index + 1))) return null;
    }
    return text.replace(/(?:%[0-9a-f]{2})+/gi, (part) => decodeURIComponent(part));
  } catch {
    return null;
  }
};
const credentialParameter = (name, spend) => {
  if (!spend(WORK_PER_NAME + name.length)) return true;
  while (name.includes("%")) {
    if (!spend(name.length)) return true;
    name = decodeMetadata(name);
    if (name === null) return true;
  }
  return isSecretLikeConfigKey(name);
};
const credentialText = (text, spend) =>
  /(?:^|[\s:"'=])(?:Bearer|Basic)\s+\S+/i.test(text) ||
  [...text.matchAll(/(?:^|[;?&#\s,{])["']?([A-Za-z0-9_.%+-]+)["']?\s*[:=]/g)]
    .some((match) => credentialParameter(match[1], spend));
// The connection store's judgement of one metadata key. Provider config declarations share it, so a declared
// field can never be a name the store refuses as a key (historical regression).
export const refusesMetadataKey = (key) => isSecretLikeConfigKey(key) || containsCredentialMaterial(key) ||
  containsCredentialMaterial(JSON.stringify({ [key]: null }));

// Declared config field names get a stricter judgement than runtime keys and values (historical regression). Provider and
// capability authors choose them in reviewed definitions, so a false positive costs a rename, while a miss lets
// a field hold a credential: a PIN, a DSN or connection string with embedded credentials, a webhook URL whose
// path is the secret, or key material named only by a trailing "key" (DB_KEY, licenseKey).
// Names are split into lowercase words at separators and at camel-case and acronym boundaries.
const fieldNameWords = (name) => name
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .split(/[\s_.+-]+/).filter(Boolean).map((word) => word.toLowerCase());
// Credential-bearing locators: webhooks (whose path is the secret), DSNs and connection strings. These names are
// refused whatever their last word, so webhookUrl, sentryDsnUrl and connectionStringType stay refused (historical regression).
const LOCATOR_WORDS = new Set(["dsn", "connstr", "connstring", "connectionstring"]);
const LOCATOR_PHRASES = new Set(["conn str", "conn string", "connection string"]);
// Words that name a credential or secret-adjacent personal data on their own (historical regression, historical regression review, historical regression): PINs,
// passcodes and one-time, access, auth, backup, recovery, unlock, security and MFA codes; seeds, mnemonics,
// recovery phrases and salts; HMAC keys, JSON Web Keys and key stores; security answers; card security codes
// (cvv, cvc, cvn, csc); and identity, tax, birth and payment data.
const SECRET_FIELD_WORDS = new Set([
  "pin", "pincode", "passcode", "otp", "totp", "hotp", "accesscode", "authcode", "backupcode", "backupcodes",
  "recoverycode", "recoverycodes", "unlockcode", "securitycode", "mfacode",
  "seed", "seedphrase", "mnemonic", "recoveryphrase", "salt", "hmac", "jwk", "jwks", "keystore", "pkcs12", "pfx",
  "privkey", "masterkey", "securityanswer", "cvv", "cvv2", "cvc", "cvc2", "cvn", "csc",
  "ssn", "iban", "dob", "dateofbirth", "taxid", "nationalid", "passportnumber", "cardnumber", "accountnumber",
  "routingnumber",
]);
// The same names written as two words (recoveryCodes, accessCode, cardNumber, taxId).
const SECRET_FIELD_PHRASES = new Set([
  "access code", "access codes", "auth code", "auth codes", "backup code", "backup codes", "recovery code",
  "recovery codes", "unlock code", "unlock codes", "security code", "security codes", "mfa code", "mfa codes",
  "security answer", "security answers", "seed phrase", "recovery phrase", "card number", "account number",
  "routing number", "tax id", "national id", "passport number",
]);
// A last word that names a property of the thing rather than the thing itself: jwksUri, jwksUrl, otpEnabled,
// hmacAlgorithm, keystoreType, passcodeLength and seedHosts name where, which kind, how long or whether, never the
// secret value. Such names are allowed unless they name a locator above, or the store's key judgement refuses
// them (historical regression).
const DESCRIPTIVE_LAST_WORDS = new Set(["url", "uri", "type", "algorithm", "length", "enabled", "hosts"]);
// A trailing "key" or "keys" names key material unless the word before it names a data, routing or public key.
// These label a column, attribute, shard, message route, cache or lookup entry, an object path, a request for
// deduplication or a public half of a key pair, never secret material: primaryKey, foreignKey, partitionKey,
// sortKey, rangeKey, shardKey, routingKey, cacheKey, publicKey, objectKey, idempotencyKey, dedupeKey, lookupKey
// and groupKey. Names that only start with "key" (keyId, keyName) are not judged by this rule. indexKey is not
// listed: the shared key classifier reads "...xKey" as an X-Key header compound and refuses it as a runtime key,
// so a declared indexKey field could never be stored.
const NON_SECRET_KEY_KINDS = new Set([
  "primary", "foreign", "partition", "sort", "range", "shard", "routing", "cache",
  "public", "object", "idempotency", "dedupe", "lookup", "group",
]);
const namesFieldCredential = (name) => {
  const words = fieldNameWords(name);
  const joined = words.join("");
  const pairs = words.slice(1).map((word, index) => words[index] + " " + word);
  if (joined.includes("webhook") || words.some((word) => LOCATOR_WORDS.has(word)) ||
      pairs.some((pair) => LOCATOR_PHRASES.has(pair))) return true;
  if (words.length > 1 && DESCRIPTIVE_LAST_WORDS.has(words.at(-1))) return false;
  if (joined.includes("dateofbirth") || words.some((word) => SECRET_FIELD_WORDS.has(word)) ||
      pairs.some((pair) => SECRET_FIELD_PHRASES.has(pair))) return true;
  const last = words.at(-1);
  return (last === "key" || last === "keys") && !NON_SECRET_KEY_KINDS.has(words.at(-2));
};
// Every [scheme:]//rest run in text, as /(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"'<>]+/gi finds them, in linear time. That
// regex retries its optional scheme from every position of a long unbroken word, so long report text stalled the
// owner loop. Start from each literal // instead and walk back over the scheme that may precede it.
const schemeCharacter = /[a-z0-9+.-]/i;
const urlCandidates = (text) => {
  const candidates = [];
  for (const match of text.matchAll(/\/\/[^\s"'<>]+/g)) {
    let start = match.index;
    if (text[start - 1] === ":") {
      let first = start - 1;
      while (first > 0 && schemeCharacter.test(text[first - 1])) first--;
      while (first < start - 1 && !/[a-z]/i.test(text[first])) first++;
      if (first < start - 1) start = first;
    }
    candidates.push(text.slice(start, match.index + match[0].length));
  }
  return candidates;
};
export const isSecretFieldName =(name) => refusesMetadataKey(name) || namesFieldCredential(name);
// The generic pass below removes one wrapper per pass and re-reads the whole rest each time, so a long chain of
// wrappers (name:name:…, name=name=…, //host//host…) cost the square of its length and stalled the owner loop.
// peelWrappers walks such a chain once. It skips a wrapper only where the generic pass would find nothing in it but
// the scheme or form-key name or host checked here and would go on with exactly the raw rest: printable text with no
// query or fragment for schemes, no URL, plus or encoded byte for form keys, plain //host/ paths without dot segments.
// Anything else ends the walk, and the rest takes the generic pass. Returns where that pass resumes, or -1 to refuse.
const SPECIAL_SCHEME = /^(?:https?|wss?|ftp|file)$/i;
const peelWrappers = (text, spend) => {
  const opaque = !/[^\x20-\x7e]|[?#]| $/.test(text);
  const form = !/\/\/[^\s"'<>]|\+|%[0-9a-f]{2}/i.test(text);
  const authority = /^[A-Za-z0-9.:/=@_~!$*()-]*$/.test(text) && !/(?:^|\/)\.\.?(?:\/|$)/.test(text);
  const lastAmpersand = text.lastIndexOf("&");
  const scheme = /( *)([A-Za-z][A-Za-z0-9.-]*):(?!\/)/y;
  const schemeLike = /\s*[a-z][a-z0-9+.-]*:/iy;
  const jsonStart = /[ \t\n\r]*[-{["0-9tfn]/y;
  // A malformed escape in the rest refuses the first skipped wrapper; later wrappers share that rest.
  let escapesChecked = !text.includes("%"), percentsChecked = escapesChecked;
  let at = 0, question = text.indexOf("?");
  for (;;) {
    scheme.lastIndex = at;
    const layer = opaque && scheme.exec(text);
    if (layer && !SPECIAL_SCHEME.test(layer[2])) {
      if (!escapesChecked && decodeMetadata(text.slice(at)) === null) return -1;
      escapesChecked = true;
      if (credentialParameter(layer[2], spend)) return -1;
      at = scheme.lastIndex;
      continue;
    }
    if (authority && text.startsWith("//", at)) {
      const slash = text.indexOf("/", at + 2);
      if (slash <= at + 2) return at;
      if (!spend(WORK_PER_NAME + slash - at)) return -1;
      try {
        const host = new URL(`https://${text.slice(at + 2, slash)}/`);
        if (host.username || host.password) return -1;
      } catch {
        return -1;
      }
      at = slash;
      continue;
    }
    schemeLike.lastIndex = at;
    if (!form || schemeLike.test(text)) return at;
    if (question !== -1 && question < at) question = text.indexOf("?", at);
    // URLSearchParams drops one leading "?" of its input.
    const start = question === -1 ? at : question + (text[question + 1] === "?" ? 2 : 1);
    const equals = text.indexOf("=", start);
    if (equals === -1 || start <= lastAmpersand) return at;
    jsonStart.lastIndex = at;
    if (jsonStart.test(text)) try { JSON.parse(text.slice(at)); return at; } catch { /* not JSON, so the form pass applies */ }
    if (!percentsChecked && decodeMetadata(text.slice(at), true) === null) return -1;
    percentsChecked = true;
    if (credentialText(text.slice(at, equals + 1), spend) || credentialParameter(text.slice(start, equals), spend)) return -1;
    at = equals + 1;
  }
};
// Chains the walk above stops at (a:#a:#…, a:?a=…, %2525…) still cost one pass per wrapper, so total work is bounded
// in proportion to the input: text that needs more is refused, never passed unread.
const WORK_PER_CHARACTER = 64;
const WORK_BASE = 65536;
const WORK_PER_NAME = 16;
export const containsCredentialMaterial = (value) => {
  // Iterative traversal covers nested JSON, redirects and encoding layers without
  // a recursion-depth bypass. Parse URL structure before decoding its values.
  const pending = [value];
  const seen = new Set();
  let budget = WORK_PER_CHARACTER * String(value).length + WORK_BASE;
  const spend = (work) => (budget -= work) >= 0;
  const inspectParameters = (parameters) => {
    for (const [name, parameter] of parameters) {
      if (credentialParameter(name, spend)) return true;
      pending.push(parameter);
    }
    return false;
  };
  while (pending.length) {
    const popped = pending.pop();
    if (seen.has(popped)) continue;
    seen.add(popped);
    if (!spend(popped.length)) return true;
    const at = peelWrappers(popped, spend);
    if (at < 0) return true;
    const current = popped.slice(at);
    seen.add(current);
    try {
      JSON.parse(current);
      // Inspect every decoded string token in valid JSON, including keys/values
      // shadowed by duplicate properties (which JSON.parse alone would discard).
      for (const token of current.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
        const decoded = JSON.parse(token[0]);
        if (/^\s*:/.test(current.slice(token.index + token[0].length)) && credentialParameter(decoded, spend)) return true;
        pending.push(decoded);
      }
      continue;
    } catch { /* Non-JSON retains the text and URL checks below. */ }
    // Form-style spaces can surface after any number of encoding/JSON layers.
    if (credentialText(current, spend) || credentialText(current.replaceAll("+", " "), spend)) return true;
    const found = urlCandidates(current);
    const candidates = [...found];
    // WHATWG URL parsing also recognizes https:host and backslashes.
    if (/^[a-z][a-z0-9+.-]*:/i.test(current.trim())) candidates.push(current.trim());
    let remainder = current;
    for (const candidate of candidates) {
      if (decodeMetadata(candidate) === null) return true;
      let url;
      try {
        url = new URL(candidate.startsWith("//") ? `https:${candidate}` : candidate);
      } catch {
        return true;
      }
      if (url.username || url.password || inspectParameters(url.searchParams)) return true;
      pending.push(url.pathname);
      if (url.hash) {
        const fragment = url.hash.slice(1);
        pending.push(fragment.replaceAll("+", " "));
        if (fragment.includes("=") && inspectParameters(new URLSearchParams(fragment.slice(fragment.indexOf("?") + 1)))) return true;
      }
      remainder = remainder.replace(candidate, "");
    }
    // A decoded fragment/redirect may itself reveal another parameter string.
    if (!candidates.length && remainder.includes("=") && inspectParameters(new URLSearchParams(remainder.slice(remainder.indexOf("?") + 1)))) return true;
    // Each changed value re-enters the same JSON/text/URL inspector.
    const decoded = decodeMetadata(remainder, true);
    if (decoded === null) return true;
    if (decoded !== remainder) pending.push(decoded);
    // Every skipped scheme wrapper would have queued itself before this decoded remainder of its URLs.
    if (decoded !== remainder && at && found.length) pending.push(popped.slice(0, at) + decoded);
  }
  return false;
};
