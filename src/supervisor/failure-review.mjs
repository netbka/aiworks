// Self-review of failures: was this failure something AIWorks could have predicted, and so prevented?
//
// Two moments use it. Before a brokered dispatch, repairSources widens the pinned snapshot with the files a predictable
// failure would otherwise lack (paths the findings or the last error name, and the callers of an exported function whose
// signature the change altered), and sameFailedInput refuses to pay for a run whose complete input equals one that already
// ended without progress. When a step stops, reviewStoppedStep sorts its attempts against a catalog of predictable causes,
// so the follow-up item says what to change before the step is planned again instead of "plan it again" (aiworks#57, #67).
import { createHash } from 'node:crypto';

const MAX_EXTRA = 24;
const MAX_SYMBOLS = 8;
const EXPORT = /^[-+]\s*export\s+(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function))/;

/** Tree paths written verbatim in `text` (a finding, its evidence, a worker's evidence-unavailable summary). */
export function namedTreePaths(text, tree) {
  const words = new Set(String(text ?? '').match(/[\w.@-]+(?:\/[\w.@-]+)+/g) ?? []);
  return tree.filter((path) => path.includes('/') && words.has(path));
}

/**
 * Exported functions whose declaration line a unified diff removes or rewrites: their callers may now be wrong. A name
 * that is only added is new, so nothing can call it yet.
 */
export function changedExports(diff) {
  const removed = new Map();
  let file = null;
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('--- ')) { file = /^--- a\/(.+)$/.exec(line)?.[1] ?? null; continue; }
    if (line[0] !== '-' || !file) continue;
    const match = EXPORT.exec(line);
    if (match) removed.set(`${file}#${match[1] ?? match[2]}`, { file, name: match[1] ?? match[2] });
  }
  return [...removed.values()].slice(0, MAX_SYMBOLS);
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const stem = (path) => path.split('/').pop().replace(SOURCE, '');

/** Source files that use `name` and name `file`'s module, given the files containing each word (`filesWith`). */
export function callersFrom(change, filesWith) {
  const importing = new Set(filesWith(stem(change.file)));
  return filesWith(change.name).filter((path) => SOURCE.test(path) && path !== change.file && importing.has(path));
}

/**
 * Extra snapshot paths, most useful first, without duplicates of `present` and at most MAX_EXTRA: tree paths the
 * findings or the last error name, then the source files that call a changed export (`filesWith(word)` returns the
 * tree paths whose content contains that whole word).
 */
export function repairSources({ tree, present = [], texts = [], diff = '', filesWith = () => [] }) {
  const have = new Set(present), out = [];
  const add = (path) => { if (!have.has(path) && out.length < MAX_EXTRA) { have.add(path); out.push(path); } };
  for (const text of texts) namedTreePaths(text, tree).forEach(add);
  for (const change of changedExports(diff)) for (const path of callersFrom(change, filesWith)) if (tree.includes(path)) add(path);
  return out;
}

/** The complete model input of a run apart from its run identity: executor, model and the whole prompt. */
export function inputKey({ executor, model = null, prompt }) {
  return createHash('sha256').update(JSON.stringify([executor, model, prompt])).digest('hex');
}

const BROKER_PROTOCOL = /edit broker refused|before text must be|duplicate edit path|no longer has active authority/i;

/** An attempt that ended without a usable step forward: the worker lacked evidence, or the run ended in an error. */
export function noProgress(outcome) {
  if (!outcome) return false;
  if (outcome.class === 'result') return outcome.value?.result === 'evidence-unavailable';
  return ['error', 'invalid-result', 'exit-without-result', 'evidence-unavailable'].includes(outcome.class);
}

/**
 * A no-progress end that the same input reproduces: the worker said it lacks evidence, or broke the brokered edit format.
 * Stream cuts, timeouts and other errors are transient and keep their retry, backoff and limits.
 */
export function deterministicNoProgress(outcome) {
  if (!outcome) return false;
  if (outcome.class === 'evidence-unavailable') return true;
  if (outcome.class === 'result') return outcome.value?.result === 'evidence-unavailable';
  return outcome.class === 'error' && BROKER_PROTOCOL.test(outcome.detail ?? '');
}

/**
 * The earlier attempt whose complete input equals `key` and that ended in a deterministic no-progress end, or null.
 * The same input on the same executor and model predicts the same end, so the caller stops instead of paying again.
 */
export function sameFailedInput(key, previous) {
  return previous.find((attempt) => attempt.inputKey === key && deterministicNoProgress(attempt.outcome)) ?? null;
}

const CATALOG = [
  { code: 'admission-budget', test: (o) => o.class === 'admission-blocked',
    prevention: 'The packet did not fit the executor before it started. Choose an executor whose context fits, or split the task, before registering it again.' },
  { code: 'broker-edit-protocol', test: (o) => BROKER_PROTOCOL.test(o.detail ?? ''),
    prevention: 'The model broke the brokered edit format, a known limit of the tool-free code broker. Give the step a declared executor that edits files directly, or a stronger model, instead of the same one again.' },
  { code: 'executor-tooling', test: (o) => /unexpected tool|not configured on this PC|executor-unavailable/i.test(o.detail ?? ''),
    prevention: 'The executor could not run as configured. Fix the host configuration or route the step to another declared executor.' },
  { code: 'context-gap', test: (o, a) => o.class === 'result' && o.value?.result === 'evidence-unavailable' && a.missing.length > 0,
    prevention: 'The worker asked for files that exist in the repository but were not in its snapshot. Name them as references or sources of the task.' },
  { code: 'self-broken-gate', test: (o) => o.class === 'result' && o.value?.verdict === 'rejected'
      && (o.value?.findings ?? []).some((f) => /full (?:local )?check is red|gate .*(?:red|fail)/i.test(`${f.id} ${f.description}`)),
    prevention: 'The change turned a green base gate red. Its snapshot must include the callers of every exported function it changes and the failing test, so a repair can see the break.' },
];

/**
 * Sort a stopped step's attempts against the catalog. `attempts` are { id, kind, outcome, inputKey?, snapshot? } in order,
 * where snapshot is the pinned { files, tree } the attempt saw. Returns { predictable, causes, unexplained }; each cause
 * names the attempts it covers, its evidence and what to change. An attempt no cause covers is listed in `unexplained`:
 * a new failure class for the catalog, not a reason to retry unchanged.
 */
export function reviewStoppedStep(attempts) {
  const causes = new Map(), unexplained = [];
  const cause = (code, prevention, id, evidence) => {
    const entry = causes.get(code) ?? { code, prevention, attempts: [], evidence: [] };
    entry.attempts.push(id); if (evidence) entry.evidence.push(String(evidence).slice(0, 300));
    causes.set(code, entry);
  };
  attempts.forEach((attempt, index) => {
    const o = attempt.outcome ?? {};
    const files = new Set((attempt.snapshot?.files ?? []).filter((f) => !f.missing).map((f) => f.path));
    const missing = attempt.snapshot ? namedTreePaths(`${o.value?.summary ?? ''} ${o.value?.tried ?? ''}`, attempt.snapshot.tree ?? []).filter((p) => !files.has(p)) : [];
    const matched = CATALOG.filter((c) => c.test(o, { missing }));
    for (const c of matched) cause(c.code, c.prevention, attempt.id, c.code === 'context-gap' ? `absent from the snapshot: ${missing.join(', ')}` : o.detail ?? o.value?.summary);
    const earlier = attempts.slice(0, index).find((a) => a.kind === attempt.kind && a.inputKey && a.inputKey === attempt.inputKey && deterministicNoProgress(a.outcome));
    if (earlier && deterministicNoProgress(o)) cause('same-input-repeat', 'An attempt repeated the complete input of an attempt that had already failed, so its result was predictable. Change the input (sources, executor or task) before trying again.', attempt.id, `same input as ${earlier.id}`);
    else if (!matched.length && noProgress(o)) unexplained.push(attempt.id);
  });
  const list = [...causes.values()];
  return { predictable: list.length > 0, causes: list, unexplained };
}

/** Markdown lines for the follow-up item: what was predictable and what to change before planning the step again. */
export function reviewLines(review) {
  if (!review.causes.length && !review.unexplained.length) return [];
  return ['', '**Self-review: could this failure have been predicted?**',
    review.predictable ? 'Yes. Change these before planning the step again:' : 'No known predictable cause was found.',
    ...review.causes.map((c) => `- \`${c.code}\` (${c.attempts.length} attempt${c.attempts.length === 1 ? '' : 's'}): ${c.prevention}${c.evidence[0] ? ` Evidence: ${c.evidence[0]}` : ''}`),
    ...(review.unexplained.length ? [`- Not covered by the catalog: ${review.unexplained.join(', ')}. Diagnose the first cause and add it to src/supervisor/failure-review.mjs.`] : [])];
}
