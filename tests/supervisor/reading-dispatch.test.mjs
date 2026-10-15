// Scoped reading at dispatch and settle (docs/design/SCOPED_READING.md sections 4 to 7, slice READ2): anchored references
// resolve at the pinned revision into a reading guide, an anchor that does not resolve widens to the whole document and is
// journalled, verifier cites never invalidate a verdict, and the cites of blocking findings reach the repair packet.
// Synthetic only: disposable git repositories, synthetic claude and gh executables, no model, network or GitHub call.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as claude from '../../src/supervisor/adapters/claude.mjs';
import * as executors from '../../src/supervisor/adapters/executors.mjs';
import { researchContext } from '../../src/supervisor/adapters/research-context.mjs';
import { declaration, environment, runUntil, skipWithoutSqlite, SQLITE } from './helpers.mjs';
const controller = SQLITE ? await import('../../src/supervisor/controller.mjs') : null;
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const skipWithoutController = SQLITE ? false : 'the controller module needs node:sqlite (Node >= 22.5)';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

// A document whose section 3 runs from line 7 to line 14 (its subsection included, up to the next level-2 heading).
const GUIDE = ['# Guide', '', '## 1. Boundary', '', 'Boundary text.', '', '## 3. Lifecycle of one task', '', 'Rule: publish only verified commits.',
  '', '### 3.1 Detail', '', 'Detail.', '', '## 4. Liveness', '', 'Liveness text.', ''].join('\n');
// The same document after a commit renamed the heading: the anchor no longer resolves.
const MOVED = GUIDE.replace('## 3. Lifecycle of one task', '## 3. Life of a task');
const SECTION = 'docs/GUIDE.md#3-lifecycle-of-one-task';
const RESOLVED_LINE = `- ${SECTION}: "## 3. Lifecycle of one task", lines 7-14 (Read with offset 7, limit 8)`;
const OLD_READING = 'Before working, read AGENTS.md at the repository root and the nearest nested AGENTS.md for every file you touch; they are the repository\'s operating contract, and the packet references list your other required reads. No saved memories or host instruction files are loaded for you.';

/** A disposable repository with GUIDE at commit A and the moved heading at commit B. */
function documents(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-reading-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Reading Test'], ['user.email', 'reading-test@example.invalid'], ['core.autocrlf', 'false']]) git(repo, 'config', key, value);
  writeFileSync(join(repo, 'AGENTS.md'), '# Rules\n');
  writeFileSync(join(repo, 'docs', 'GUIDE.md'), GUIDE);
  writeFileSync(join(repo, 'docs', 'data.json'), '{"a":1}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'A');
  const a = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'docs', 'GUIDE.md'), MOVED);
  git(repo, 'commit', '-q', '-am', 'B');
  return { root, repo, a, b: git(repo, 'rev-parse', 'HEAD') };
}

// ---- Resolution at dispatch (section 4) ----

test('a heading moved between two commits resolves at the first and falls back with missing at the second', { skip: skipWithoutController }, (t) => {
  const { repo, a, b } = documents(t);
  const references = ['AGENTS.md', SECTION, 'docs/NOPE.md#x', 'docs/data.json#a'];
  // The worker-writable checkout is never read: an uncommitted edit there changes nothing.
  writeFileSync(join(repo, 'docs', 'GUIDE.md'), '# Rewritten in the working tree\n');
  const atA = controller.resolveReferences({ git: ['git'], repoPath: repo, revision: a, references });
  assert.deepEqual(atA, [
    { reference: SECTION, path: 'docs/GUIDE.md', anchor: '3-lifecycle-of-one-task', resolved: true, heading: '3. Lifecycle of one task', level: 2, slug: '3-lifecycle-of-one-task', from: 7, to: 14 },
    { reference: 'docs/NOPE.md#x', path: 'docs/NOPE.md', anchor: 'x', resolved: false, reason: 'unreadable' },
    { reference: 'docs/data.json#a', path: 'docs/data.json', anchor: 'a', resolved: false, reason: 'not-markdown' },
  ], 'a whole-document reference has no record');
  const atB = controller.resolveReferences({ git: ['git'], repoPath: repo, revision: b, references: [SECTION] });
  assert.deepEqual(atB, [{ reference: SECTION, path: 'docs/GUIDE.md', anchor: '3-lifecycle-of-one-task', resolved: false, reason: 'missing' }]);
  assert.deepEqual(controller.resolveReferences({ git: ['git'], repoPath: repo, revision: a, references: ['AGENTS.md'] }), []);
});

test('the reading guide lists sections, whole documents, fallbacks, added cites and overflow; none without an anchor', { skip: skipWithoutController }, (t) => {
  const { repo, a, b } = documents(t);
  const revision = a;
  assert.equal(controller.readingGuide({ revision, references: ['AGENTS.md', 'docs/GUIDE.md'], declared: 2, resolutions: [] }), null);
  const references = ['AGENTS.md', SECTION, 'docs/GUIDE.md#4-liveness'];
  const resolutions = controller.resolveReferences({ git: ['git'], repoPath: repo, revision, references });
  assert.equal(controller.readingGuide({ revision, references, declared: 2, resolutions, added: [{ reference: 'docs/GUIDE.md#4-liveness', finding: 'F1' }],
    overflow: [{ reference: 'docs/GUIDE.md#1-boundary', finding: 'F2' }] }), [
    `Reading guide (derived from packet.references at ${a}):`,
    '- AGENTS.md: whole document',
    RESOLVED_LINE,
    'Added from the verifier\'s findings:',
    '- docs/GUIDE.md#4-liveness: "## 4. Liveness", lines 15-17 (Read with offset 15, limit 3) (finding F1)',
    'Findings cite sections not listed here: see the constraints.',
  ].join('\n'));
  const fallback = controller.resolveReferences({ git: ['git'], repoPath: repo, revision: b, references: [SECTION] });
  assert.equal(controller.readingGuide({ revision: b, references: [SECTION], declared: 1, resolutions: fallback }),
    `Reading guide (derived from packet.references at ${b}):\n- docs/GUIDE.md: whole document (the section #3-lifecycle-of-one-task was not found at this revision)`);
  // Heading text is data: control characters removed, a secret-shaped heading withheld.
  const secret = [{ reference: 'docs/S.md#k', path: 'docs/S.md', anchor: 'k', resolved: true, heading: `key ghp_${'A'.repeat(36)}`, level: 2, from: 1, to: 2 },
    { reference: 'docs/S.md#c', path: 'docs/S.md', anchor: 'c', resolved: true, heading: 'a\u0007b', level: 3, from: 3, to: 3 }];
  const guide = controller.readingGuide({ revision, references: ['docs/S.md#k', 'docs/S.md#c'], declared: 2, resolutions: secret });
  assert.ok(guide.includes('- docs/S.md#k: section, lines 1-2') && !guide.includes('ghp_'));
  assert.ok(guide.includes('"### a b"'));
});

// ---- Prompts (section 5) ----

// The same inputs as the base revision's prompts; their sha256 were taken from claude.buildPrompt at 66fbf59 (before READ2).
const PACKET = { version: 1, tenantId: 'example-org', projectId: 'sampleapp', environment: 'research', taskId: 'T1', stageId: 'implement',
  runId: 'c.T1.implement.1', role: 'implementer', revision: 'a'.repeat(40), authorityDigest: 'f'.repeat(64), access: 'write',
  goal: 'first task (example-org/sampleapp#437). Produce the first artifact.', constraints: ['Synthetic test constraint.'],
  acceptance: ['artifact exists'], references: [{ path: 'AGENTS.md', revision: 'a'.repeat(40) }, { path: 'docs/GUIDE.md', revision: 'a'.repeat(40) }] };
const BASE = { packet: PACKET, packetDigest: 'd'.repeat(64), repository: 'example-org/sampleapp', issue: 437, branch: 'campaign/c/T1', baseSha: 'b'.repeat(40) };
const PROMPTS = {
  implementCommit: [{ role: 'implementer', deliverable: 'commit', ...BASE, targetSha: null, report: null, reportDigest: null, note: null }, 'c63517a149dfe4893ca89cdea2a51ab327e80fff683ca7f89ab269a9b996348b'],
  repairCommit: [{ role: 'implementer', deliverable: 'commit', ...BASE, targetSha: null, report: '# Report', reportDigest: 'e'.repeat(64), note: 'This is repair round 1.' }, '96aaeda48166ba6d5ef35031da161e6c7fd42103be97ee71a7f50172ccb82cc1'],
  verifyCommit: [{ role: 'verification', deliverable: 'commit', ...BASE, targetSha: 'c'.repeat(40), report: '# Report', reportDigest: 'e'.repeat(64), note: null }, '5245d4df886e39b17f4fa98704dd2435098f8533ba78221303c8868b0006dea6'],
  implementReport: [{ role: 'implementer', deliverable: 'report', ...BASE, targetSha: null, report: null, reportDigest: null, note: null }, 'b2e50786ebf762be3959e5ab56395cae14b7cf1c58b8aec550b2bcf4a63c1f12'],
  verifyReport: [{ role: 'verification', deliverable: 'report', ...BASE, targetSha: 'b'.repeat(40), report: '# Findings', reportDigest: 'e'.repeat(64), note: null }, '4465b815a997b6c0662c9426cdea6a439207c2ddf219954bb00951ca62eec3bc'],
};

test('an anchor-free packet gets byte-identical prompts: same sha256 as before READ2, with or without guide: null', () => {
  for (const [name, [args, digest]] of Object.entries(PROMPTS)) {
    assert.equal(sha256(claude.buildPrompt(args)), digest, `${name} is byte-identical to the base revision's prompt`);
    assert.equal(claude.buildPrompt({ ...args, guide: null }), claude.buildPrompt(args), name);
    assert.equal(executors.buildPrompt({ ...args, guide: null }), executors.buildPrompt(args), name);
    assert.ok(claude.buildPrompt(args).includes(OLD_READING));
  }
});

test('a guided prompt carries the section 5 wording per role and the guide after the packet; the gate rules stay before it', () => {
  const guide = `Reading guide (derived from packet.references at ${'a'.repeat(40)}):\n${RESOLVED_LINE}`;
  const implement = executors.buildPrompt({ ...PROMPTS.implementCommit[0], guide });
  assert.ok(implement.includes(claude.IMPLEMENTER_READING_RULE) && !implement.includes(claude.VERIFIER_READING_RULE));
  assert.ok(!implement.includes(OLD_READING) && implement.includes('they are the repository\'s operating contract. No saved memories'));
  assert.ok(implement.indexOf(executors.GATE_RULES[0]) < implement.indexOf('Task packet (sha256 '));
  assert.ok(implement.indexOf('```\n\n' + guide + '\n\nYour working directory') > 0, 'the guide follows the packet');
  const verify = executors.buildPrompt({ ...PROMPTS.verifyCommit[0], guide });
  assert.ok(verify.includes(claude.VERIFIER_READING_RULE) && !verify.includes(claude.IMPLEMENTER_READING_RULE) && verify.includes(guide));
  assert.match(claude.VERIFIER_READING_RULE, /reader of record: read each referenced document in full/);
  assert.match(claude.IMPLEMENTER_READING_RULE, /say in your report which sections you read/);
});

test('a browser (AGY) web task with anchors is prompted without a guide', () => {
  const guide = `Reading guide (derived from packet.references at ${'a'.repeat(40)}):\n${RESOLVED_LINE}`;
  const packet = { ...PACKET, references: [{ path: SECTION, revision: 'a'.repeat(40) }] };
  const prompt = executors.buildPrompt({ ...PROMPTS.implementReport[0], packet, web: { urls: ['https://example.invalid/'] }, guide });
  assert.ok(prompt.includes('VISUAL ACCEPTANCE') && !prompt.includes('Reading guide') && !prompt.includes(claude.IMPLEMENTER_READING_RULE));
});

// ---- Verifier cites (section 6.1) ----

const verdict = (findings, verdictName = 'rejected') => ({ verdict: verdictName, targetSha: 'c'.repeat(40), reportDigest: 'e'.repeat(64), summary: 's', findings, checks: [] });
const expect = { deliverable: 'commit', targetSha: 'c'.repeat(40), reportDigest: 'e'.repeat(64) };

test('no cite can make a verifier result invalid: malformed, unsafe, too many and non-string cites all validate', () => {
  assert.deepEqual(claude.VERIFIER_SCHEMA.properties.findings.items.properties.cites,
    { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 672, pattern: claude.CITE_PATTERN } });
  const bad = [['../x.md#a', 'secrets.md#b', 'a#b#c', 'docs/A.md#UPPER', 'e'], 42, 'not-an-array', [null, { x: 1 }], ['x'.repeat(5000)]];
  for (const cites of bad) {
    const value = verdict([{ id: 'F1', severity: 'blocking', description: 'd', cites }]);
    assert.equal(claude.validResult('verification', value, expect), null, JSON.stringify(cites).slice(0, 60));
    const stdoutText = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', structured_output: value, result: '' });
    for (const stage of [null, 'work']) {
      const outcome = executors.classify({ executorKind: 'claude-cli', stage, role: 'verification', run: { exitCode: 0 }, stdoutText, stderrText: '', expect, now: 0 });
      assert.equal(outcome.class, 'result', `${stage}: ${outcome.detail}`);
    }
  }
  // Everything else is validated as before.
  assert.match(claude.validResult('verification', verdict([{ id: 'F1', severity: 'blocking', description: 'd', extra: 1 }]), expect), /structured_output invalid/);
});

test('a verifier result with four cites keeps its verdict: three cite-dropped reasons and one resolved section', { skip: skipWithoutController }, (t) => {
  const { repo, a } = documents(t);
  const value = verdict([{ id: 'F1', severity: 'blocking', description: 'skips the rule', cites: ['../x.md#a', 'secrets.md#b', 'docs/NOPE.md#c', SECTION] },
    { id: 'N1', severity: 'non-blocking', description: 'style' }]);
  const settled = controller.settleCites({ git: ['git'], repoPath: repo, targetSha: a, value, implementer: null, task: 'T1', op: 'op.verify.2' });
  assert.equal(settled.value.verdict, 'rejected');
  assert.deepEqual(settled.value.findings, [{ id: 'F1', severity: 'blocking', description: 'skips the rule', cites: [SECTION] }, value.findings[1]]);
  assert.deepEqual(settled.events, [
    ['cite-dropped', { op: 'op.verify.2', finding: 'F1', cite: '../x.md#a', reason: 'unsafe-path' }],
    ['cite-dropped', { op: 'op.verify.2', finding: 'F1', cite: 'secrets.md#b', reason: 'secret-like' }],
    ['cite-dropped', { op: 'op.verify.2', finding: 'F1', cite: 'docs/NOPE.md#c', reason: 'no-such-file' }],
  ]);
  assert.deepEqual(settled.record, [{ finding: 'F1', cite: SECTION, path: 'docs/GUIDE.md', anchor: '3-lifecycle-of-one-task', heading: '3. Lifecycle of one task', from: 7, to: 14 }]);
  // A fifth cite, a malformed one and a section that is not there: dropped, dropped, kept as the whole document.
  const more = controller.settleCites({ git: ['git'], repoPath: repo, targetSha: a, implementer: null, task: 'T1', op: 'o',
    value: verdict([{ id: 'F2', severity: 'blocking', description: 'd', cites: ['docs/GUIDE.md#9-none', 'a#b#c', 'AGENTS.md', 'AGENTS.md', 'docs/GUIDE.md#1-boundary'] }]) });
  assert.deepEqual(more.value.findings[0].cites, ['docs/GUIDE.md', 'AGENTS.md']);
  assert.deepEqual(more.events.map(([kind, detail]) => [kind, detail.reason]),
    [['cite-section-fallback', 'missing'], ['cite-dropped', 'malformed'], ['cite-dropped', 'malformed']]);
  assert.equal(controller.citeProblem('docs/.env#x'), 'secret-like');
  assert.equal(controller.citeProblem('/abs.md#x'), 'unsafe-path');
  assert.equal(controller.citeProblem(7), 'malformed');
  assert.equal(controller.citeProblem(SECTION), null);
});

// ---- Classification (section 6.3) ----

test('classification yields covered, section-miss and unreferenced-doc on three implementer packets', { skip: skipWithoutController }, (t) => {
  const { repo, a } = documents(t);
  const value = verdict([{ id: 'F1', severity: 'blocking', description: 'd', cites: [SECTION] }]);
  const packets = { covered: [SECTION], 'section-miss': ['AGENTS.md', 'docs/GUIDE.md#1-boundary'], 'unreferenced-doc': ['AGENTS.md'] };
  for (const [expected, references] of Object.entries(packets)) {
    assert.equal(controller.classifyCite(references, 'docs/GUIDE.md', '3-lifecycle-of-one-task'), expected);
    const settled = controller.settleCites({ git: ['git'], repoPath: repo, targetSha: a, value, implementer: { references, report: '# Report' }, task: 'T1', op: 'o' });
    const event = { covered: 'cite-covered', 'section-miss': 'section-miss', 'unreferenced-doc': 'unreferenced-doc' }[expected];
    assert.deepEqual(settled.events, [[event, { task: 'T1', op: 'o', finding: 'F1', path: 'docs/GUIDE.md', anchor: '3-lifecycle-of-one-task', implementerRead: null }]]);
    assert.equal(settled.record[0].classification, expected);
  }
  assert.equal(controller.classifyCite(['docs/GUIDE.md'], 'docs/GUIDE.md', '3-lifecycle-of-one-task'), 'covered', 'the whole document covers every section');
  // A non-blocking finding's cite is resolved but not classified.
  const nonBlocking = controller.settleCites({ git: ['git'], repoPath: repo, targetSha: a, implementer: { references: ['AGENTS.md'], report: '' }, task: 'T1', op: 'o',
    value: verdict([{ id: 'N1', severity: 'non-blocking', description: 'd', cites: [SECTION] }], 'accepted') });
  assert.deepEqual(nonBlocking.events, []);
  assert.equal(nonBlocking.value.verdict, 'accepted');
});

test('implementerRead is true, false and null from three report shapes', { skip: skipWithoutController }, () => {
  const listed = '# Report\n\nDone.\n\nSections read:\n- AGENTS.md\n- docs/GUIDE.md#3-lifecycle-of-one-task\n\n## Commands\n';
  const other = '# Report\n\n## Sections I read\n\n- docs/GUIDE.md#1-boundary\n\n## Notes\ndocs/GUIDE.md#3-lifecycle-of-one-task is mentioned elsewhere.\n';
  const none = '# Report\n\nRead docs/GUIDE.md#3-lifecycle-of-one-task.\n';
  assert.equal(controller.implementerRead(listed, 'docs/GUIDE.md', '3-lifecycle-of-one-task'), true);
  assert.equal(controller.implementerRead(other, 'docs/GUIDE.md', '3-lifecycle-of-one-task'), false, 'only the list counts');
  assert.equal(controller.implementerRead(none, 'docs/GUIDE.md', '3-lifecycle-of-one-task'), null);
  assert.equal(controller.implementerRead(listed, 'AGENTS.md', null), true, 'a whole-document cite matches its path');
});

// ---- Repair packet (section 6.4) ----

test('the repair packet lists the declared references then the cite; the constraint carries the rule; a plan packet is untouched', { skip: skipWithoutController }, (t) => {
  const { repo, a } = documents(t);
  const findings = [{ id: 'F1', severity: 'blocking', description: 'skips the publication rule', cites: [SECTION, 'AGENTS.md'] }];
  const declared = ['AGENTS.md', 'docs/GUIDE.md#1-boundary'];
  const reading = controller.packetReferences({ declared, kind: 'implement', findings, maxReferences: 24 });
  assert.deepEqual(reading, { references: [...declared, SECTION], added: [{ reference: SECTION, finding: 'F1' }], overflow: [] }, 'de-duplicated against the declared');
  const resolutions = controller.resolveReferences({ git: ['git'], repoPath: repo, revision: a, references: reading.references });
  assert.equal(controller.findingConstraint(findings[0], resolutions),
    `Blocking verifier finding F1: skips the publication rule (rule: ${SECTION} "3. Lifecycle of one task") (rule: AGENTS.md)`);
  assert.ok(controller.readingGuide({ revision: a, references: reading.references, declared: 2, resolutions, added: reading.added })
    .endsWith(`Added from the verifier's findings:\n${RESOLVED_LINE} (finding F1)`));
  // Without cites, and for the integration and CI findings, the constraint text is today's.
  assert.equal(controller.findingConstraint({ id: 'F2', description: 'd' }), 'Blocking verifier finding F2: d');
  assert.equal(controller.findingConstraint({ id: 'ci-failure', description: 'd', cites: [SECTION] }), 'Blocking CI finding ci-failure: d');
  assert.equal(controller.findingConstraint({ id: 'F3', description: 'x'.repeat(2500), cites: [SECTION] }).length, 2000, 'within the 2000-character cap');
  // A planning step's or a verification's references are the declared ones, whatever the task's findings carry.
  for (const kind of ['plan', 'verify']) assert.deepEqual(controller.packetReferences({ declared, kind, findings, maxReferences: 24 }), { references: declared, added: [], overflow: [] });
});

test('a declaration with 24 references gets the cite in the constraint text only', { skip: skipWithoutController }, (t) => {
  const { repo, a } = documents(t);
  const declared = Array.from({ length: 23 }, (_, index) => `docs/D${index}.md`).concat('docs/GUIDE.md#1-boundary');
  const findings = [{ id: 'F1', severity: 'blocking', description: 'd', cites: [SECTION] }];
  const reading = controller.packetReferences({ declared, kind: 'implement', findings, maxReferences: 24 });
  assert.deepEqual(reading.references, declared, 'declared references are never dropped');
  assert.deepEqual(reading.overflow, [{ reference: SECTION, finding: 'F1' }]);
  const resolutions = controller.resolveReferences({ git: ['git'], repoPath: repo, revision: a, references: [...reading.references, SECTION] });
  assert.match(controller.findingConstraint(findings[0], resolutions), /\(rule: docs\/GUIDE\.md#3-lifecycle-of-one-task "3\. Lifecycle of one task"\)$/);
  assert.ok(controller.readingGuide({ revision: a, references: reading.references, declared: 24, resolutions, overflow: reading.overflow })
    .endsWith('Findings cite sections not listed here: see the constraints.'));
});

// ---- Brokered research (Codex research-only) ----

function research(t, references) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-reading-research-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  mkdirSync(join(workspace, 'docs'), { recursive: true });
  writeFileSync(join(workspace, 'AGENTS.md'), '# Rules\n');
  writeFileSync(join(workspace, 'docs', 'GUIDE.md'), GUIDE);
  const gh = join(root, 'gh.mjs');
  writeFileSync(gh, `const path = process.argv.slice(2).find((v) => v.startsWith('repos/'));
    const base = 'https://api.github.com/' + path.split('/').slice(0, 3).join('/');
    let value = path.split('/').length === 3 ? { full_name: path.slice(6) } : path.includes('/commits/') ? { sha: 'a'.repeat(40) }
      : path.includes('per_page=100') ? [[]] : [];
    const bind = (item) => ({ ...item, url: base + '/synthetic' });
    value = Array.isArray(value) ? value.map((page) => Array.isArray(page) ? page.map(bind) : bind(page)) : bind(value);
    console.log(JSON.stringify(value));`);
  const d = declaration({ tasks: [{ ...declaration().tasks[0], deliverable: 'report', references }] });
  const text = researchContext({ gh: [process.execPath, gh], workspace, declaration: d, task: d.tasks[0], now: 0, revision: 'b'.repeat(40) });
  return JSON.parse(text.split('<research-context>\n')[1].split('\n</research-context>')[0]).sources.filter((item) => !item.source.startsWith('https://'));
}

test('brokered research reads the path part and ships the section only when it resolves', (t) => {
  const at = `example-org/sampleapp@${'b'.repeat(40)}:`;
  assert.deepEqual(research(t, ['AGENTS.md', SECTION, 'docs/GUIDE.md#9-none', 'docs/GUIDE.md#8-none']), [
    { source: `${at}AGENTS.md`, content: '# Rules\n' },
    { source: `${at}${SECTION} (lines 7-14)`, content: GUIDE.split('\n').slice(6, 14).join('\n') },
    { source: `${at}docs/GUIDE.md (whole document: the section #9-none is missing at this revision)`, content: GUIDE },
  ], 'an unresolved section ships the whole document once');
  assert.deepEqual(research(t, [SECTION, 'docs/GUIDE.md']), [{ source: `${at}docs/GUIDE.md`, content: GUIDE }], 'a document listed whole ships whole');
  assert.throws(() => research(t, ['docs/.env#x']), /Unsafe research reference/);
});

// ---- End to end through the controller (worker execution needs Windows Job Object containment) ----

// A synthetic claude: an implementer writes the files its step names and commits; a verifier returns its step's findings.
const FAKE = `import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
const sessionId = args[args.indexOf('--session-id') + 1];
const prompt = readFileSync(0, 'utf8');
const role = prompt.includes('INDEPENDENT VERIFIER') ? 'verify' : 'implement';
const state = process.env.FAKE_CLAUDE_STATE;
const callsFile = join(state, 'calls.jsonl');
const n = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.role === role).length : 0;
appendFileSync(callsFile, JSON.stringify({ role, sessionId, cwd: process.cwd(), args }) + '\\n');
const step = JSON.parse(readFileSync(join(state, 'scenario.json'), 'utf8'))[role]?.[n] ?? {};
const git = (...a) => spawnSync('git', a, { encoding: 'utf8', windowsHide: true }).stdout.trim();
const ok = (value) => { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, num_turns: 2,
  total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [], structured_output: value, result: '' })); process.exit(0); };
if (role === 'implement') {
  for (const [path, content] of Object.entries(step.files ?? { ['work-' + sessionId + '.txt']: 'work\\n' })) {
    mkdirSync(dirname(join(process.cwd(), path)), { recursive: true });
    writeFileSync(join(process.cwd(), path), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'work ' + sessionId);
  ok({ result: 'resolved', summary: 'implemented', headSha: git('rev-parse', 'HEAD'), report: step.report ?? '# Report\\n\\nsession ' + sessionId });
}
const targetSha = /Target commit: ([0-9a-f]{40})/.exec(prompt)[1];
const reportDigest = /reportDigest ([0-9a-f]{64})/.exec(prompt)[1];
ok(step.findings ? { verdict: 'rejected', targetSha, reportDigest, summary: 'rejected', findings: step.findings, checks: [] }
  : { verdict: 'accepted', targetSha, reportDigest, summary: 'accepted', findings: [], checks: [{ command: 'npm test', result: 'pass' }] });
`;
// A git that cannot read blobs: every anchor of a dispatch falls back, and nothing else changes.
const NO_BLOBS = `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'cat-file' && args[1] === 'blob') process.exit(128);
process.exit(spawnSync('git', args, { stdio: 'inherit', windowsHide: true }).status ?? 1);
`;
const FIXED = { GIT_AUTHOR_NAME: 'Fake Worker', GIT_AUTHOR_EMAIL: 'worker@example.invalid', GIT_COMMITTER_NAME: 'Fake Worker',
  GIT_COMMITTER_EMAIL: 'worker@example.invalid', GIT_AUTHOR_DATE: '2026-10-15T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-15T12:00:00Z' };

/** A synthetic environment whose base holds docs/GUIDE.md, and a controller with the reading fake (and optionally NO_BLOBS). */
function campaign(t, { references, scenario, noBlobs = false, fixed = false, files = {}, constraints = null, tasks = null }) {
  // The identities are the ones environment() sets for every test; only the dates are put back afterwards.
  const saved = Object.fromEntries(['GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'].map((key) => [key, process.env[key]]));
  // Fixed identities and dates make two environments' base commits, and so their packets, identical.
  if (fixed) Object.assign(process.env, FIXED);
  let env;
  try {
    env = environment();
    mkdirSync(join(env.repo, 'docs'), { recursive: true });
    writeFileSync(join(env.repo, 'docs', 'GUIDE.md'), GUIDE);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(env.repo, path), content);
    git(env.repo, 'add', '-A');
    git(env.repo, 'commit', '-q', '-m', 'guide');
    git(env.repo, 'push', '-q', 'origin', 'main');
  } finally {
    if (fixed) for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  env.setScenario(scenario);
  writeFileSync(join(env.tmp, 'reading-claude.mjs'), FAKE);
  writeFileSync(join(env.tmp, 'no-blobs-git.mjs'), NO_BLOBS);
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const decl = declaration({ tasks: tasks ?? [{ ...declaration().tasks[0], references }] });
  if (constraints) decl.constraints = constraints;
  campaignStart(store, decl);
  const config = { ...env.config, commands: { ...env.config.commands, claude: [process.execPath, join(env.tmp, 'reading-claude.mjs')],
    ...(noBlobs ? { git: [process.execPath, join(env.tmp, 'no-blobs-git.mjs')] } : {}) } };
  const ctl = new controller.Controller({ store, config, dataDir: env.dataDir, fault: null });
  const id = decl.campaignId;
  return { env, store, ctl, id,
    op: (name, task = 'T1') => store.get('SELECT * FROM operations WHERE id = ?', `${id}.${task}.${name}`),
    prompt: (name, task = 'T1') => readFileSync(join(store.get('SELECT run_dir FROM operations WHERE id = ?', `${id}.${task}.${name}`).run_dir, 'prompt.txt'), 'utf8'),
    journal: (pattern) => store.all('SELECT kind, detail FROM journal WHERE campaign_id = ? ORDER BY seq', id).filter((row) => pattern.test(row.kind)).map((row) => [row.kind, row.detail]) };
}

test('dispatch: the implement run resolves the section, the verify run at the moved heading falls back, both journalled', { skip: skipWithoutSqlite }, async (t) => {
  const c = campaign(t, { references: ['AGENTS.md', SECTION], scenario: { implement: [{ files: { 'docs/GUIDE.md': MOVED } }] } });
  await runUntil(c.ctl, c.store, c.id, (state) => state.control === 'finished');
  const implement = c.op('implement.1'), verify = c.op('verify.2');
  for (const op of [implement, verify]) assert.deepEqual(op.packet.references.map((item) => item.path), ['AGENTS.md', SECTION], 'the packet keeps what the plan said');
  assert.deepEqual(c.journal(/^reference-section-/), [
    ['reference-section-resolved', { op: implement.id, anchored: 1, resolved: 1, fallback: 0 }],
    ['reference-section-resolved', { op: verify.id, anchored: 1, resolved: 0, fallback: 1 }],
    ['reference-section-fallback', { task: 'T1', op: verify.id, path: 'docs/GUIDE.md', anchor: '3-lifecycle-of-one-task', reason: 'missing' }],
  ]);
  const implementPrompt = c.prompt('implement.1'), verifyPrompt = c.prompt('verify.2');
  assert.ok(implementPrompt.includes(`Reading guide (derived from packet.references at ${implement.base_sha}):\n- AGENTS.md: whole document\n${RESOLVED_LINE}`));
  assert.ok(implementPrompt.includes(claude.IMPLEMENTER_READING_RULE) && !implementPrompt.includes(OLD_READING));
  assert.ok(verifyPrompt.includes('- docs/GUIDE.md: whole document (the section #3-lifecycle-of-one-task was not found at this revision)'));
  assert.ok(verifyPrompt.includes(claude.VERIFIER_READING_RULE));
  assert.equal(c.store.task(c.id, 'T1').state, 'done', 'a fallback never blocks');
});

test('dispatch: a packet with anchors has the same digest whether or not the anchor resolves', { skip: skipWithoutSqlite }, async (t) => {
  const resolving = campaign(t, { references: ['AGENTS.md', SECTION], scenario: {}, fixed: true });
  const failing = campaign(t, { references: ['AGENTS.md', SECTION], scenario: {}, fixed: true, noBlobs: true });
  for (const c of [resolving, failing]) await runUntil(c.ctl, c.store, c.id, (state) => state.control === 'finished');
  const [a, b] = [resolving.op('implement.1'), failing.op('implement.1')];
  assert.equal(a.base_sha, b.base_sha, 'both dispatched at the same revision');
  assert.equal(a.packet_digest, b.packet_digest);
  assert.deepEqual(a.packet, b.packet);
  assert.ok(resolving.prompt('implement.1').includes(RESOLVED_LINE));
  assert.ok(failing.prompt('implement.1').includes('- docs/GUIDE.md: whole document (the section #3-lifecycle-of-one-task could not be read at this revision)'));
  assert.deepEqual(failing.journal(/^reference-section-fallback$/).map(([, detail]) => detail.reason), ['unreadable', 'unreadable'], 'implement and verify both fell back');
});

test('dispatch: an anchor-free declaration gets today\'s packets and prompts and no reading journal', { skip: skipWithoutSqlite }, async (t) => {
  const c = campaign(t, { references: ['AGENTS.md', 'docs/GUIDE.md'], scenario: { verify: [{ findings: [{ id: 'F1', severity: 'blocking', description: 'missing evidence' }] }] } });
  await runUntil(c.ctl, c.store, c.id, (state) => state.control === 'finished');
  for (const name of ['implement.1', 'verify.2', 'implement.3', 'verify.4']) {
    const op = c.op(name);
    assert.deepEqual(op.packet.references, [{ path: 'AGENTS.md', revision: op.base_sha }, { path: 'docs/GUIDE.md', revision: op.base_sha }], name);
    const prompt = c.prompt(name);
    assert.ok(prompt.includes(OLD_READING) && !prompt.includes('Reading guide') && !prompt.includes(claude.VERIFIER_READING_RULE), name);
  }
  assert.ok(c.op('implement.3').packet.constraints.includes('Blocking verifier finding F1: missing evidence'));
  assert.deepEqual(c.journal(/^(reference-section|cite-|section-miss|unreferenced-doc)/), []);
  assert.equal(c.op('verify.2').outcome.reading, undefined, 'a result without cites is stored as before');
});

test('dispatch: a rejection that cites a rule reaches the repair packet; bad cites are dropped and the verdict stands', { skip: skipWithoutSqlite }, async (t) => {
  const c = campaign(t, { references: ['AGENTS.md', 'docs/GUIDE.md#1-boundary'], scenario: {
    implement: [{ report: '# Report\n\nSections read:\n- docs/GUIDE.md#1-boundary\n' }],
    verify: [{ findings: [{ id: 'F1', severity: 'blocking', description: 'skips the publication rule', cites: [SECTION, '../x.md#a', 'docs/NOPE.md'] }] }],
  } });
  await runUntil(c.ctl, c.store, c.id, (state) => state.control === 'finished');
  const verify = c.op('verify.2'), repair = c.op('implement.3');
  assert.equal(verify.outcome.class, 'result');
  assert.equal(verify.outcome.value.verdict, 'rejected');
  assert.deepEqual(verify.outcome.reading.cites, [{ finding: 'F1', cite: SECTION, path: 'docs/GUIDE.md', anchor: '3-lifecycle-of-one-task',
    heading: '3. Lifecycle of one task', from: 7, to: 14, classification: 'section-miss', implementerRead: false }]);
  assert.deepEqual(c.journal(/^(cite-|section-miss|unreferenced-doc)/), [
    ['section-miss', { task: 'T1', op: verify.id, finding: 'F1', path: 'docs/GUIDE.md', anchor: '3-lifecycle-of-one-task', implementerRead: false }],
    ['cite-dropped', { op: verify.id, finding: 'F1', cite: '../x.md#a', reason: 'unsafe-path' }],
    ['cite-dropped', { op: verify.id, finding: 'F1', cite: 'docs/NOPE.md', reason: 'no-such-file' }],
  ], 'in cite order');
  assert.deepEqual(repair.packet.references.map((item) => item.path), ['AGENTS.md', 'docs/GUIDE.md#1-boundary', SECTION]);
  assert.ok(repair.packet.references.every((item) => item.revision === repair.base_sha));
  assert.ok(repair.packet.constraints.includes(`Blocking verifier finding F1: skips the publication rule (rule: ${SECTION} "3. Lifecycle of one task")`));
  assert.ok(c.prompt('implement.3').includes(`Added from the verifier's findings:\n${RESOLVED_LINE} (finding F1)`));
  assert.equal(c.store.task(c.id, 'T1').state, 'done');
});

test('dispatch: cites that would push the repair packet past its byte budget stay in the constraint text only', { skip: skipWithoutSqlite }, async (t) => {
  const heading = (index) => `Rule ${index} ${'r'.repeat(140)}`;
  const slug = (index) => `rule-${index}-${'r'.repeat(140)}`;
  const findings = Array.from({ length: 8 }, (_, finding) => ({ id: `F${finding}`, severity: 'blocking', description: 'x'.repeat(1990),
    cites: Array.from({ length: 4 }, (_, cite) => `docs/LONG.md#${slug(finding * 4 + cite)}`) }));
  // Seven long campaign constraints and eight 2000-character findings fill most of the 32 KiB packet budget.
  const c = campaign(t, { references: ['AGENTS.md', 'docs/GUIDE.md#1-boundary'], scenario: { verify: [{ findings }] },
    files: { 'docs/LONG.md': Array.from({ length: 32 }, (_, index) => `## ${heading(index)}\n\nText ${index}.\n`).join('\n') },
    constraints: Array.from({ length: 7 }, (_, index) => `Synthetic constraint ${index}: ${'c'.repeat(1970)}`) });
  await runUntil(c.ctl, c.store, c.id, (state) => state.control === 'finished');
  const repair = c.op('implement.3');
  assert.deepEqual(repair.packet.references.map((item) => item.path), ['AGENTS.md', 'docs/GUIDE.md#1-boundary'], 'declared only: the cites did not fit');
  const withCites = { ...repair.packet, references: [...repair.packet.references, ...findings.flatMap((item) => item.cites).slice(0, 22).map((path) => ({ path, revision: repair.base_sha }))] };
  assert.ok(Buffer.byteLength(JSON.stringify(withCites)) > 32768, 'with the cites the packet would exceed its budget');
  const ruled = repair.packet.constraints.filter((item) => item.startsWith('Blocking verifier finding F'));
  assert.equal(ruled.length, 8);
  assert.ok(ruled.every((item) => item.length === 2000));
  const prompt = readFileSync(join(repair.run_dir, 'prompt.txt'), 'utf8');
  assert.ok(prompt.includes('Findings cite sections not listed here: see the constraints.') && !prompt.includes('Added from the verifier\'s findings'));
  assert.equal(c.store.task(c.id, 'T1').state, 'done');
});

// ---- Sibling carry-forward (section 7.3, slice READ3) ----

test('a sibling inherits a missed section only when it marks sections of that document; at most 4 per document and 8 per dispatch', { skip: skipWithoutController }, () => {
  const miss = (task, finding, path, anchor) => ({ task, op: `c.${task}.verify.2`, finding, path, anchor, implementerRead: null });
  const misses = [miss('A', 'F1', 'docs/GUIDE.md', '3-lifecycle-of-one-task')];
  assert.deepEqual(controller.siblingSections({ misses, task: 'B', references: ['AGENTS.md', 'docs/GUIDE.md#4-liveness'] }),
    [{ reference: SECTION, from: { task: 'A', finding: 'F1' } }]);
  assert.deepEqual(controller.siblingSections({ misses, task: 'B', references: ['docs/GUIDE.md'] }), [], 'a whole-document sibling reads it already');
  assert.deepEqual(controller.siblingSections({ misses, task: 'B', references: ['docs/GUIDE.md', 'docs/GUIDE.md#4-liveness'] }), [], 'whole wins over sections');
  assert.deepEqual(controller.siblingSections({ misses, task: 'B', references: ['AGENTS.md', 'docs/OTHER.md#x'] }), [], 'a sibling without the document gets nothing');
  assert.deepEqual(controller.siblingSections({ misses, task: 'A', references: ['docs/GUIDE.md#4-liveness'] }), [], 'the task itself gets its cites through its repair packet');
  assert.deepEqual(controller.siblingSections({ misses, task: 'B', references: [SECTION] }), [], 'a section the sibling lists already');
  assert.deepEqual(controller.siblingSections({ misses: [miss('A', 'F1', 'docs/GUIDE.md', null)], task: 'B', references: ['docs/GUIDE.md#4-liveness'] }), [],
    'a whole-document miss carries no section');
  // Bounds: newest first, 4 per document, 8 per dispatch, each section once.
  const many = [...Array.from({ length: 6 }, (_, index) => miss('A', `F${index}`, 'docs/ONE.md', `s${index}`)), miss('C', 'F9', 'docs/ONE.md', 's0'),
    ...Array.from({ length: 6 }, (_, index) => miss('C', `G${index}`, 'docs/TWO.md', `t${index}`)),
    ...Array.from({ length: 3 }, (_, index) => miss('D', `H${index}`, 'docs/THREE.md', `u${index}`))];
  const extended = controller.siblingSections({ misses: many, task: 'B', references: ['docs/ONE.md#intro', 'docs/TWO.md#intro', 'docs/THREE.md#intro'] });
  assert.equal(controller.CARRY_PER_DOCUMENT, 4);
  assert.equal(controller.CARRY_PER_DISPATCH, 8);
  assert.deepEqual(extended.map((item) => item.reference), ['docs/ONE.md#s0', 'docs/ONE.md#s1', 'docs/ONE.md#s2', 'docs/ONE.md#s3',
    'docs/TWO.md#t0', 'docs/TWO.md#t1', 'docs/TWO.md#t2', 'docs/TWO.md#t3']);
  assert.deepEqual(extended[0].from, { task: 'A', finding: 'F0' }, 'the newest finding names the section');
});

test('the guide lists inherited sections after the packet\'s own, labelled prompt only with the finding', { skip: skipWithoutController }, (t) => {
  const { repo, a } = documents(t);
  const references = ['AGENTS.md', 'docs/GUIDE.md#4-liveness'];
  const extended = [{ reference: SECTION, from: { task: 'T1', finding: 'F1' } }];
  const resolutions = controller.resolveReferences({ git: ['git'], repoPath: repo, revision: a, references: [...references, SECTION] });
  assert.equal(controller.readingGuide({ revision: a, references, declared: 2, resolutions, extended }), [
    `Reading guide (derived from packet.references at ${a}):`,
    '- AGENTS.md: whole document',
    '- docs/GUIDE.md#4-liveness: "## 4. Liveness", lines 15-17 (Read with offset 15, limit 3)',
    'Added from this campaign\'s verifier findings (prompt only, not in the packet):',
    `${RESOLVED_LINE} (finding T1/F1)`,
  ].join('\n'));
  assert.equal(controller.readingGuide({ revision: a, references, declared: 2, resolutions, extended: [] }),
    controller.readingGuide({ revision: a, references, declared: 2, resolutions }), 'nothing inherited, nothing changed');
});

// T1 marks the boundary section and is rejected for skipping the lifecycle rule (a section-miss). T2 marks another section
// of the same document, T3 reads it whole and T4 does not name it.
const SIBLINGS = [
  { id: 'T1', issue: 437, title: 'first task', deliverable: 'commit', goal: 'Produce the first artifact.', dependsOn: [], acceptance: ['artifact exists'], references: ['AGENTS.md', 'docs/GUIDE.md#1-boundary'] },
  { id: 'T2', issue: 438, title: 'sectioned sibling', deliverable: 'commit', goal: 'Produce the second artifact.', dependsOn: ['T1'], acceptance: ['artifact exists'], references: ['AGENTS.md', 'docs/GUIDE.md#4-liveness'] },
  { id: 'T3', issue: 439, title: 'whole sibling', deliverable: 'commit', goal: 'Produce the third artifact.', dependsOn: ['T1'], acceptance: ['artifact exists'], references: ['AGENTS.md', 'docs/GUIDE.md'] },
  { id: 'T4', issue: 440, title: 'other sibling', deliverable: 'commit', goal: 'Produce the fourth artifact.', dependsOn: ['T1'], acceptance: ['artifact exists'], references: ['AGENTS.md'] },
];

test('dispatch: a sibling that marks sections inherits the missed section in its guide; its packet is what it would have been', { skip: skipWithoutSqlite }, async (t) => {
  // One after the other: the synthetic workers find their scenario through the environment of the newest campaign.
  const missed = campaign(t, { tasks: SIBLINGS, fixed: true, scenario: {
    verify: [{ findings: [{ id: 'F1', severity: 'blocking', description: 'skips the publication rule', cites: [SECTION] }] }] } });
  await runUntil(missed.ctl, missed.store, missed.id, (state) => state.control === 'finished');
  const clean = campaign(t, { tasks: SIBLINGS, fixed: true, scenario: {} });
  await runUntil(clean.ctl, clean.store, clean.id, (state) => state.control === 'finished');
  assert.deepEqual(missed.journal(/^section-miss$/).map(([, detail]) => [detail.task, detail.finding, detail.anchor]), [['T1', 'F1', '3-lifecycle-of-one-task']]);
  // Prompt only: every sibling's packet and digest equal those of the campaign where T1 missed nothing.
  for (const task of ['T2', 'T3', 'T4']) {
    const [a, b] = [missed.op('implement.1', task), clean.op('implement.1', task)];
    assert.equal(a.base_sha, b.base_sha, `${task} implement.1 dispatched at the same revision`);
    assert.equal(a.packet_digest, b.packet_digest, `${task} implement.1`);
    assert.deepEqual(a.packet, b.packet, `${task} implement.1`);
    // A verification is pinned to the worker's commit, whose time differs between the two runs; nothing else does.
    const [x, y] = [missed.op('verify.2', task).packet, clean.op('verify.2', task).packet];
    assert.deepEqual(x, JSON.parse(JSON.stringify(y).replaceAll(y.revision, x.revision)), `${task} verify.2`);
    assert.deepEqual(x.references.map((item) => item.path), SIBLINGS.find((item) => item.id === task).references, `${task} verify.2 lists the declared references only`);
  }
  const inherited = `Added from this campaign's verifier findings (prompt only, not in the packet):\n${RESOLVED_LINE} (finding T1/F1)`;
  assert.ok(missed.prompt('implement.1', 'T2').includes(inherited), 'the sectioned sibling inherits the missed section');
  assert.ok(missed.prompt('verify.2', 'T2').includes(inherited));
  assert.ok(!clean.prompt('implement.1', 'T2').includes('Added from this campaign'));
  for (const task of ['T3', 'T4']) assert.ok(!missed.prompt('implement.1', task).includes('Added from this campaign'), `${task} gets nothing`);
  assert.deepEqual(missed.journal(/^reading-guide-extended$/), ['implement.1', 'verify.2'].map((name) => ['reading-guide-extended',
    { op: missed.op(name, 'T2').id, task: 'T2', from: { task: 'T1', finding: 'F1' }, path: 'docs/GUIDE.md', anchor: '3-lifecycle-of-one-task' }]));
  assert.deepEqual(clean.journal(/^reading-guide-extended$/), []);
  // Carry-forward writes no spec and no amendment.
  for (const table of ['plan_amendments', 'task_specs']) {
    assert.equal(missed.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, clean.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, table);
  }
  assert.deepEqual(missed.store.tasks(missed.id).map((task) => task.state), ['done', 'done', 'done', 'done']);
});
