# Scoped reading: section-marked references, verifier citations and repair rounds that carry the rule

Design for the AIWorks delivery supervisor. It answers one question raised in planning on 2026-10-14: can the plan mark which parts of a document a worker must read, so that a worker does not read every referenced document in full, without losing the rules that live in the parts it skipped?

The answer is yes, under three conditions that this document turns into mechanism: the narrowing is a *reading guide*, never a change to what binds the worker; the independent verifier reads the whole text and names the section a rejected change violates; and every rejection feeds the exact section back into the repair round, so the same rule is not missed twice. Everything that can go wrong (a heading that moved, a planner that invented an anchor, a verifier that cites a file that does not exist) degrades to *wider* reading with a journal entry, never to silence.

This document follows the shape of the six merged designs. Section 2 is observed code with file and line references at `ec7b1b3` (main on 2026-10-15; first written at `3ba1dd7` and re-checked after STA10 to STA14, #151 and #152 merged); sections 3 to 9 are the design; section 10 is what is written but deliberately **parked**; section 13 is the implementation slices that [PROJECT_WORKSPACE_PLAN.md §6](../PROJECT_WORKSPACE_PLAN.md#6-build-order-lanes-and-file-ownership) sequences as lane READ.

## 1. What the owner gets

- A worker that is told *which sections* of `docs/SUPERVISOR.md` matter for its task reads those sections first and spends its context on the change, not on 627 lines of runbook. The documents still bind it; what changes is where it starts.
- When a change is sent back, the step screen says *why* in the words of the document: "returned: the change skips the publication rule in SUPERVISOR.md §3 (Lifecycle of one task)". The repair run receives that section as a required read, so the second attempt is not a guess.
- Nothing is approved twice, nothing asks the owner anything. A plan that marks sections badly is visible in the journal and in `supervisor baseline`, where the owner can see whether narrowing is paying off, with unknown reported as unknown.

## 2. Where things stand today (observed)

| Item | Observed | Where |
| --- | --- | --- |
| Task references | 1 to 24 repository-relative paths, each a `safePath`: no leading `/`, none of `\ : %` or control characters, no empty, `.` or `..` segment. `#` is allowed by that rule today, but nothing gives it a meaning. | `src/supervisor/campaign.mjs:44-45`, `:234-236`; secret-like references refused at `:363-364` |
| Packet references | `{ path, revision }` pairs built at dispatch from the spec, one per declared path, pinned to the dispatched revision. At most `maxReferences` (24) by policy. | `src/supervisor/controller.mjs:1791`; `scripts/lib/worker-context.mjs:89-90`; `registry/worker-context-policy.json` |
| Packet schema path rule | Refuses a leading `/`, `\ : %`, control characters, `.`/`..` segments, `//` and a trailing `/`. A `#` passes. | `schemas/worker-task-packet.schema.json:35-41` |
| Governance authority pointers | Already carry `path#anchor`: `PROJECT_PATH` allows one `#` fragment of `[A-Za-z0-9._-]+`. The secret-like path pattern is anchor-aware (`[/#]|$`). | `scripts/lib/worker-context.mjs:22-39` |
| What the implementer is told | "the packet references list your other required reads" — every reference is read in full. | `src/supervisor/adapters/claude.mjs:151` |
| What the verifier is told | The same packet, the diff and the report; nothing about references beyond the same sentence. | `src/supervisor/adapters/claude.mjs:139-168` |
| Verifier findings | `{ id, severity, description, evidence? }`, at most 30. No field names a document or a section. | `src/supervisor/adapters/claude.mjs:35-46` |
| Repair rounds | Blocking findings become packet constraints: `Blocking verifier finding <id>: <description>`, at most 8, each cut at 2000 characters (integration and CI findings carry their own label); the rejected report is reproduced as data. References are the declared ones again. | `src/supervisor/controller.mjs:1776-1791`; `claude.mjs:189-196` |
| Brokered research (Codex) | Reads every reference by path from the workspace and ships the content in the prompt. A path with `#` would not be found: `realpathSync` throws and the research context fails. | `src/supervisor/adapters/research-context.mjs:18` |
| Browser worker (AGY) | Cannot read repository documents at all; told that references are not blockers. | `src/supervisor/adapters/agy.mjs:129` |
| Child admission | A5 checks that child references are safe and not secret-like; nothing else. | `src/supervisor/plan.mjs:203` |
| Planning step (PLAN) | Built by STA10 (#154; merged, not known to be deployed). Its instruction is `PLAN_RULE`: a proposed task names `references` among its fields, with no rule about how to choose them. The controller appends a planning context. The generated PLAN and ACCEPT specs read the union of the declared tasks' references, at most 16. | `src/supervisor/adapters/executors.mjs:88`; `src/supervisor/controller.mjs:111-112`, `:437-452`, `:1816` |
| Coordinator drafts | Two prompts. The message coordinator may return a `proposedCampaign` in the declaration format; the intake coordinator (STA12, #160) drafts a declaration whose tasks carry `references (repository paths to read first)`. Neither says anything about references beyond that, and the intake draft is checked with the same `validateDeclaration` as a registered declaration. | `src/supervisor/coordinator.mjs:293`, `:267`; `src/supervisor/intake.mjs:314-328` (`checkDraft`) |
| Baseline | `supervisor baseline` reads the store and reports cost and outcome counts; `aiworks-baseline/1`. | `src/supervisor/baseline.mjs:63`, `:183` |

Two consequences of the table. First, the grammar is almost free: `docs/SUPERVISOR.md#3-lifecycle-of-one-task` already passes every validator on the path, so the design is mostly about giving it a meaning and a fallback. Second, nothing today links a rejection to a rule, so the repair implementer is told *what* was wrong but never *where it is written*; that is the gap the verifier citation closes.

## 3. The reference grammar

A task reference is one of:

- `path` — the whole document, exactly as today.
- `path#anchor` — one section of a Markdown document. `anchor` is a GitHub-style heading slug: `[a-z0-9_-]+`, at most 160 characters, one `#` only.

Rules:

- `path` follows `safePath` and is not secret-like, as today. The secret-like test runs on the path with the anchor removed and on the whole string (the pattern is anchor-aware already).
- Several sections of one document are several entries: `docs/SUPERVISOR.md#1-boundary`, `docs/SUPERVISOR.md#3-lifecycle-of-one-task`. They count separately toward the 24. A document listed both whole and by section is redundant, not an error; the whole-document entry wins and the sectioned ones become "start here" marks (section 5).
- The grammar is the same in a declaration, in a coordinator draft and in a child amendment. Admission A5 keeps its code (`WIDEN_CAPABILITY`) for a secret-like or unsafe path; a malformed anchor (two `#`, forbidden characters, empty) is `INVALID_TASK` for a child and a plain validation error for a declaration.
- The anchor is part of the task spec, so it is part of `scopeDigest` like every other reference. A declaration without anchors keeps its `scopeDigest` and `authorityDigest` byte for byte, because the grammar adds no key and changes no canonicalisation. Code older than this change accepts an anchored reference (the validators pass it) but gives it no meaning: the worker is told to read the path, which fails on a literal `#`. That is why slice READ1 (validation and resolver) and READ2 (dispatch) must both be deployed before an operator writes anchors into a private declaration; SUPERVISOR.md §1 says so.

Why heading slugs and not line ranges: lines move with every edit of the document; headings move rarely, and when they do, the resolver below says so. Why not free text ("the publication rule"): it cannot be resolved deterministically, and this design admits no model into resolution.

**Slug algorithm** (the one GitHub renders, so the anchors in existing documents and links keep working): take the heading text without its leading `#` marks and trailing spaces; lower-case it; drop every character that is not a letter, a digit, a space, a hyphen or an underscore; replace each space with a hyphen; the second heading with the same slug gets `-1` appended, the third `-2`. Headings are ATX headings (`#` to `######`) outside fenced code blocks. Setext headings are not recognised; AIWorks documents use none.

## 4. Resolution at dispatch

Resolution is deterministic code in a new pure module `src/supervisor/reading.mjs`, called by the controller inside the dispatch path after the revision is fixed and before the prompt is built. Nothing in it calls a model.

For each reference with an anchor:

1. Read the file at the pinned revision: `git show <revision>:<path>` in the main checkout (never the worker-writable worktree), as the controller already does for `.claude/settings.json` (`controller.mjs:1839`). A file over 2 MiB, a binary file or a path that is not `.md` or `.markdown` resolves to the whole document with reason `not-markdown`.
2. Build the heading table: `[{ level, text, slug, line }]`, slugs as in section 3.
3. Match the anchor: an exact slug match wins. Failing that, if exactly one slug starts with `<anchor>-`, that heading is the match (`#6-child` finds `#6-child-tasks-inside-the-envelope`). Two or more prefix matches are ambiguous and no match is made.
4. The section extent runs from the heading line to the line before the next heading of the same or a higher level, or to the end of the file.
5. Record the outcome: `{ path, anchor, resolved: true, heading, from, to }` or `{ path, anchor, resolved: false, reason }` with reason `missing`, `ambiguous`, `not-markdown` or `unreadable`.

**Fallback is always wider.** An unresolved anchor makes that entry a whole-document read in the reading guide. The packet keeps the `path#anchor` string, because the packet records what the plan said, and the digest binds it; the guide, which is prompt text derived from the packet, says "whole document (the section `#x` was not found at this revision)". The journal gets `reference-section-fallback { task, op, path, anchor, reason }`. Status shows it under the task (section 8). Nothing blocks, nothing waits for the owner, and no automatic retry is spent on it: a plan with a stale anchor runs with more reading, which is the worst case of today.

Resolution runs on every dispatch, not once per task, because the revision differs between an implement run and its verification, and between repair rounds; headings can move between them.

**Cost.** One `git show` per anchored document per dispatch, cached within the dispatch by `(revision, path)`. Dispatches are rare events next to worker runs; this is not a hot path.

## 5. What each role is told

The packet is the authority and does not change shape. What changes is the prompt the adapters build from it (`claude.buildPrompt`, wrapped by `executors.buildPrompt`; `agy.buildPrompt` for browser work).

### 5.1 Implementer (commit and report work)

The sentence at `claude.mjs:151` becomes two:

> Before working, read AGENTS.md at the repository root and the nearest nested AGENTS.md for every file you touch; they are the repository's operating contract. No saved memories or host instruction files are loaded for you.
>
> The reading guide below lists your required reads. A whole-document entry is read in full. A section entry names the part of a document the plan marked for this task: read it in full, and read the rest of that document only where it bears on the files you change or the commands you run. The packet constraints and acceptance criteria bind you whether or not a section repeats them. If your change touches a subject the marked sections do not cover, find and read the section that does; say in your report which sections you read.

Then the guide, derived from the resolution record:

```
Reading guide (derived from packet.references at <revision>):
- docs/SUPERVISOR.md#3-lifecycle-of-one-task: "## 3. Lifecycle of one task", lines 79-163 (Read with offset 79, limit 85)
- docs/SUPERVISOR.md#1-boundary: "## 1. Boundary", lines 9-66
- docs/design/WORK_ENVELOPE.md: whole document (the section #6-children was not found at this revision)
- AGENTS.md: whole document
- Added from this campaign's verifier findings (prompt only, not in the packet): docs/SUPERVISOR.md#4-liveness-and-failure-semantics (finding T1/publication-2, lines 164-190)
```

The last line form is the sibling carry-forward of section 7.3. The `Read with offset, limit` hint matches the headless Claude CLI's `Read` tool; Codex and Cursor adapters receive the same guide text, because `withStageRule(withGateRules(claude.buildPrompt(...)))` is the path for all three CLI kinds (`executors.mjs:98-99`).

The sentence "say in your report which sections you read" is deliberate. It costs one line of the report and makes a miss attributable: when the verifier cites a section the implementer says it read, the plan was fine and the model was not; when the implementer did not read it, the plan was narrow. The journal records both cases differently (section 8).

### 5.2 Verifier

The verifier is the role that holds the whole text, which is the condition under which narrowing the implementer is safe at all:

> packet.references name the documents that govern this task; section marks (`#anchor`) say where the implementer was told to start. You are the reader of record: read each referenced document in full, section marks included, and check the change against everything in it that bears on the files changed and the commands run. When a finding rests on a rule written in a document, cite the section in `cites` as `path#heading-slug` (at most 4 per finding) so that the repair round and the owner can read the rule you applied. A citation names where a rule is written; it never widens what the packet allows.

The verifier's cost goes up by exactly what the implementer's goes down by, at most; it is the same documents. Whether the trade is good is what section 8 measures. It is not assumed.

### 5.3 Browser worker (AGY)

Unchanged: it cannot read repository documents and is told so (`agy.mjs:129`). A web acceptance task with anchored references is valid; its anchors are resolved and journalled like any other, and the guide is not sent. Its Claude-with-browser alternative receives the guide.

### 5.4 Coordinator and planning step

Both coordinator drafting instructions, the `proposedCampaign` step (`coordinator.mjs:293`) and the intake task fields (`coordinator.mjs:267`), gain one sentence:

> In every task's `references`, mark the sections that bear on the task as `path#heading-slug` (one entry per section, the slugs GitHub renders for that document's headings); list a document whole only when most of it applies. The verifier reads every referenced document in full, so a narrow mark costs a rejection at worst, never a missed rule.

The planning step (WORK_ENVELOPE §6.2, slice STA10) gets the same sentence in its instruction `PLAN_RULE` (`executors.mjs:88`). A child's anchored references go through A5 unchanged. Nothing here changes the owner's approval: the owner approves outcome, files and capabilities (the envelope); references are reads inside the repository at a pinned revision and were never an approval item.

## 6. Verifier citations and repair rounds

### 6.1 The field

`VERIFIER_SCHEMA.findings[].cites`: optional array, at most 4 strings, each at most 672 characters (512 path + `#` + 160 anchor), pattern the reference grammar of section 3. The result validator (`claude.mjs:273-277`) keeps its behaviour: an **invalid `cites` entry never invalidates the verdict**. It is dropped, the finding stays, and the journal records `cite-dropped { op, finding, cite, reason }` with reason `unsafe-path`, `secret-like`, `malformed`. A verdict that could be thrown away for a bad citation would send the task into another verification run for no gain; the finding is what matters.

### 6.2 Resolution of citations

At settle time (`controller.mjs:648-654`, where the verifier result is checked against the target), each kept cite is resolved at `op.target_sha` with the section 4 resolver:

- resolved: `{ path, anchor, heading, from, to }` is stored on the finding (`task.findings[].cites[]` keeps the string; the resolution record is in the operation outcome, not the spec).
- path exists, anchor missing or ambiguous: the cite is kept as a whole-document citation, journal `cite-section-fallback`.
- path absent at the target revision: the cite is dropped, journal `cite-dropped { reason: 'no-such-file' }`. A verifier that cites a document that is not in the repository is wrong about where the rule lives; the finding's description still carries what it saw.

### 6.3 Classification of each blocking finding's citations

For a blocking finding with a resolved cite, the controller compares the cite with the *implementer's* packet references of the run under review (`operations.packet` of the implement operation that produced `target_sha`):

| The implementer packet had | Classification | Journal event |
| --- | --- | --- |
| the same `path#anchor`, or the whole `path` | `covered` — the rule was in the required reads | `cite-covered` |
| `path` with other sections only | `section-miss` — the plan marked the wrong sections | `section-miss` |
| no entry for `path` | `unreferenced-doc` — the plan did not name the document | `unreferenced-doc` |

Each event carries `{ task, op, finding, path, anchor, implementerRead: true | false | null }`, where `implementerRead` is whether the implementer's report named that section among the sections it read (section 5.1), parsed by a bounded regular expression over the report's "sections read" list; `null` when the report has no such list. This is the one place where report text is read by code, and it is read as data to count, never as an instruction.

### 6.4 What the repair round receives

Today a repair packet carries `Blocking verifier finding <id>: <description>` as a constraint. With citations:

- the constraint text becomes `Blocking verifier finding <id>: <description> (rule: docs/SUPERVISOR.md#3-lifecycle-of-one-task "3. Lifecycle of one task")` for each resolved cite, within the existing 2000-character cap per constraint;
- each resolved cite of a blocking finding is appended to `packet.references` as `{ path: 'path#anchor', revision }`, after the declared references, de-duplicated against them, until the packet holds `maxReferences` (24). Cites that do not fit stay in the constraint text only. Declared references are never dropped to make room.
- the reading guide lists each added section under "Added from the verifier's findings" with the finding id.

The repair packet's digest changes, as every repair packet's does (different `runId`, different constraints). This is the same kind of addition as the findings themselves: evidence from the task's own history, bounded, at a pinned revision, read-only. It widens no write domain, capability, destination, release mode, limit or acceptance (the WORK_ENVELOPE A4 to A10 list), so it is not a scope change and needs no approval. [AGENTS.md](../../AGENTS.md#owner-intervention) is respected: no new owner gate.

## 7. Self-healing

The word means: a wrong input (a stale anchor, an invented anchor, a bad citation, a narrow plan) is corrected by deterministic code within the campaign, without an owner action and without a model being asked to fix the plan. Each behaviour below is built because its effect is certain and its cost is bounded. Behaviours whose effect is uncertain are in section 10, parked.

### 7.1 Stale or invented anchors heal to the whole document

Section 4. The worst case of a bad anchor is today's behaviour (read the whole document) plus one journal entry and one status line. There is no path by which a bad anchor makes a worker read *less* than the document, and no path by which it stops a task.

### 7.2 A rejected change carries its rule into the repair round

Section 6.4. The second attempt reads the section that the first attempt violated, named by an independent reader, at the revision under repair. This is the direct answer to "the agent did not read the whole document": the part it needed arrives with the rejection.

### 7.3 Sibling tasks in the same campaign inherit what the verifier found

When a blocking finding in task A is classified `section-miss` or `unreferenced-doc` for `path#anchor`, every *later* dispatch in the same campaign of a task whose references name `path` by section (not whole) gets `path#anchor` added to its reading guide, labelled with the finding. This is prompt text only: the packet of a sibling is unchanged, so declared tasks' packets stay byte-identical to what they would have been, and nothing is re-admitted. Bounds: at most 4 added sections per document and 8 per dispatch, newest findings first; a task that references `path` whole gets nothing added (it reads everything already); a task that does not reference `path` at all gets nothing added either (the plan did not name the document for that task, and adding reads a plan did not ask for is the parked P1, not this).

Why built and not parked: within one campaign the tasks share files, constraints and documents; a rule that one task missed is, with high probability, a rule its siblings face. The cost is one section of reading. The failure mode is an unnecessary section in a prompt. The effect is certain in direction (a sibling cannot be worse off for being pointed at a rule its sibling broke) even if its size is unknown.

### 7.4 Citations that cannot be resolved never cost a run

Section 6.1 and 6.2. Dropping a cite keeps the verdict. Nothing about citations can create an `invalid-result`, so nothing about them can trigger the provider sidestep or escalation rules of MODEL_ROUTING, which treat `invalid-result` as a signal about the model.

### 7.5 The cap is handled, not hit

Section 6.4. The 24-reference cap is honoured by priority (declared first, then cites in finding order) and overflow degrades to text in the constraint, which the worker still reads. A declaration or child that itself has 24 references leaves no room for cites; the guide says so ("findings cite sections not listed here: see the constraints"). That is correct behaviour, not an error.

## 8. Measurement: journal, status and baseline

Nothing in this design claims a saving. The numbers below exist so the owner can see one, or its absence.

**Journal events** (campaign lane, bounded payloads, no document text): `reference-section-resolved` (one per dispatch with the count only: `{ op, anchored, resolved, fallback }`), `reference-section-fallback`, `cite-dropped`, `cite-section-fallback`, `cite-covered`, `section-miss`, `unreferenced-doc`, `reading-guide-extended` (7.3, `{ op, task, from: { task, finding }, path, anchor }`).

**Status** (`src/supervisor/api.mjs`, per task): `reading: { anchored: n, fallbacks: [{ path, anchor, reason }], misses: { section: n, unreferenced: n }, extended: n }`, null for a task whose dispatches predate the change. The dashboard half (UI18) renders it in plain words; the supervisor half never writes prose.

**Baseline** (`supervisor baseline`, report `aiworks-baseline/2`, additive): per campaign and overall, `reading: { dispatchesGuided, anchors: { resolved, fallback }, blockingFindings: { withCites, covered, sectionMiss, unreferencedDoc, implementerReadAnyway }, repairRoundsWithRule, guidesExtended }`, with `null` where the store predates the events. Together with the existing cost and outcome fields, this is what "did narrowing help" is read from: the comparison the owner wants is *cost per accepted outcome* and *repair rounds per task* for campaigns whose tasks were mostly anchored against campaigns whose tasks were not. The baseline prints both cohorts side by side when both exist and says "not comparable" when either has fewer than 5 finished tasks. It never computes a saving in dollars; [MODEL_ROUTING §8](MODEL_ROUTING.md) already states why unknown stays unknown.

**What a bad outcome looks like, so it is recognisable:** `sectionMiss` high and `implementerReadAnyway` low means plans are narrow and workers trust them; the fix is in the planner's marking (section 10, P1 is the candidate), not in the workers. `sectionMiss` high and `implementerReadAnyway` high means the marks are fine and the model ignores what it read; that is a routing signal, not a reading one. `fallback` high means anchors drift; the documents were restructured and the declarations are stale, which the status line shows per task.

## 9. Threats

| Threat | Where it is stopped |
| --- | --- |
| An anchor used to point outside the repository (`../`, absolute, `%`-encoding) | `safePath` on the path part before the `#`; the anchor part allows only `[a-z0-9_-]`. Section 3. |
| A secret-like path hidden behind an anchor (`.env#x`, `secrets.md#y`) | The secret-like pattern is already anchor-aware; it is applied to the whole string and to the path part. Admission A5 and declaration validation refuse it. |
| A verifier cites a path to make the repair implementer read something outside the repository | Cites pass the same `safePath` and secret-like rules, then must exist at the target revision in the repository; otherwise dropped. Section 6.2. |
| Citation spam to push declared references out of the packet | Cap by priority: declared first, 4 cites per finding, 24 total; overflow to text. Section 6.4. |
| A finding description or cite that carries injected instructions | Unchanged: findings are rendered as constraints inside the packet, which the prompt declares the authority but which cannot widen tools or permissions; the controller never acts on finding text beyond resolving a path. |
| Heading text used to inject into the prompt through the guide | The guide prints the heading text in quotes, truncated to 120 characters, control characters removed, after `containsSecret`. It is data in a prompt, like every file the worker reads anyway. |
| A document so large that resolution stalls dispatch | 2 MiB limit; over it, whole-document fallback with reason `unreadable`. |
| A reading guide that hides a rule by pointing at the wrong section | Mitigated, not prevented: the verifier reads everything (5.2), the implementer is told the document still binds it (5.1), and a miss is named and fed back (6, 7.3). No design that reads less can prevent it; this one makes it visible and non-repeating. |

## 10. Parked: written, not built

Each item here was considered, judged either small in effect or uncertain in outcome, and parked with the evidence that would un-park it. They are listed so a later reviewer sees the reasoning, not a gap.

**P1. Cross-campaign miss history in the planner prompts.** Feed the coordinator and the planning step a bounded list of "sections earlier plans in this repository missed" (`section-miss` and `unreferenced-doc` events with their task goals, newest first, at most 12). *Why parked:* the planner is a fresh session with a different request each time; whether a list of past misses improves its marks is unknown, and the list competes for the same context the design is trying to save. It also makes a plan depend on another campaign's history, which is a new input the coordinator's read-only boundary does not have today. *Un-park when:* baseline shows `sectionMiss` above 1 per 5 blocking findings across at least 3 finished campaigns with anchored references, and a dry run on those campaigns' recorded prompts shows the list fits in under 1,500 characters. Then it is one additive slice on `coordinator.mjs` and the plan prompt, with the list read from the local store only.

**P2. "Sections I needed" from the verifier on accepted work.** Let the verifier return, on `accepted`, the sections it found necessary, to tighten later marks. *Why parked:* it adds output to the common path (most verifications accept), the signal is a model's opinion with no rejection to anchor it, and section 8 already measures the only outcome that matters (misses). *Un-park when:* P1 is built and its list is found to be too thin.

**P3. Line-range references (`path:L10-L40`).** *Why parked:* lines move with every edit; the fallback would fire constantly and the plan would be stale within a day. Heading slugs give the same narrowing with a resolution that survives edits. *Un-park when:* a document type without headings becomes a common reference (large JSON schemas, for example); then a JSON-pointer form (`path#/definitions/x`) is the better candidate than lines.

**P4. Raising `maxReferences` above 24.** Sectioned references use entries faster. *Why parked:* 24 is a C0 policy value that the lifecycle contract says to tune from evidence, and no evidence exists yet. The cap is handled by priority (7.5), so nothing breaks at the cap. *Un-park when:* the baseline shows cites overflowing to text in more than 1 in 10 repair rounds.

**P5. Section digests in the packet.** Bind the resolved section text (its SHA-256) into the packet, so that a worker's claim "I read §3" can be checked against the exact text at the revision. *Why parked:* the revision already pins the text; a per-section digest proves nothing the revision does not, and it changes the packet schema (`references[]` would need a third key), which is a C0 contract change for no new guarantee.

**P6. Automatic declaration amendment when anchors fall back.** When a declared anchor is missing at three dispatches in a row, propose an amended declaration with the resolved replacement. *Why parked:* declarations are the owner's immutable scope; the supervisor proposing edits to them crosses from runtime into authority, which [AGENTS.md](../../AGENTS.md#authorized-work) keeps with the operator. The fallback already runs the task correctly; the status line already names the stale anchor. The gain is a cleaner journal, which is small.

**P7. Reading-guide hints by file ownership.** Derive marks automatically from the task's `writes` (a task writing `src/dashboard/` gets `docs/OPERATIONS_DASHBOARD.md` sections that mention those paths). *Why parked:* it requires a text search over documents at dispatch, whose precision is unknown, and it would add reads the plan did not ask for, the same objection as P1. *Un-park when:* P1 exists and `unreferencedDoc` dominates `sectionMiss` in the baseline, which would mean plans forget documents rather than sections.

## 11. Decisions taken here (not owner-reserved)

- Heading slugs, not line ranges or free text, name a section (section 3).
- Narrowing lives in the prompt's reading guide; the packet schema and C0 contract are unchanged. The packet carries the `path#anchor` string the plan wrote (section 4).
- An unresolved anchor always widens to the whole document and never blocks, retries or asks (section 4, 7.1).
- The verifier reads referenced documents in full and cites; a bad citation is dropped, never a reason to reject the verdict (sections 5.2, 6.1).
- Resolved citations of blocking findings enter the repair packet's references after the declared ones, within the existing cap (section 6.4).
- Sibling carry-forward is campaign-local and prompt-only (section 7.3). Cross-campaign learning is parked (P1).
- No saving is claimed; the baseline reports cohorts and says "not comparable" below 5 finished tasks per cohort (section 8).
- No new owner decision is needed. Reads inside the repository at a pinned revision are not an approval item under WORK_ENVELOPE A4 to A10.

## 12. Open unknowns

- Whether headless workers honour "read the section, then the rest only where it bears on your files" rather than reading everything anyway. The report's "sections read" list (5.1) and `implementerReadAnyway` (8) are how that is learned; nothing is assumed.
- The real share of a worker's context taken by references today. `supervisor baseline` has token usage per operation where the provider reports it; the first cohort comparison gives the first number.
- How Codex and Cursor render the `Read with offset, limit` hint; the guide is phrased so a worker without that tool reads the line range by any means.

## 13. Implementation slices

Each slice is one reviewable PR with synthetic tests only (disposable stores and git repositories as in `tests/supervisor/helpers.mjs`; no model, network or GitHub call) and ends with `npm run check`. Every change under `src/supervisor/` needs an independent review of the exact head before merge ([AGENTS.md](../../AGENTS.md#review-and-runtime-maintenance)). Merged is not deployed. The slices are sequenced in [PROJECT_WORKSPACE_PLAN.md §6](../PROJECT_WORKSPACE_PLAN.md#6-build-order-lanes-and-file-ownership) as lane READ, after the current turns on the shared files.

| # | Outcome | Files it owns | Tests | Acceptance | Depends on | Waits for a decision |
| --- | --- | --- | --- | --- | --- | --- |
| **READ1** | `path#anchor` validates in declarations and child amendments; a pure resolver exists; no behaviour change | `src/supervisor/reading.mjs` (new: `parseReference`, `slugify`, `headings(text)`, `resolveSection(text, anchor)`, `extent`); `src/supervisor/campaign.mjs` (reference rule accepts one anchor; secret-like on both forms); `src/supervisor/plan.mjs` (A5 uses `parseReference`); `docs/SUPERVISOR.md` §1 (grammar, deploy note) | `tests/supervisor/reading.test.mjs`: slug of every heading of the six design documents equals the anchor its own links use; exact, unique-prefix, ambiguous-prefix and missing anchors; fenced code blocks ignored; duplicate headings `-1`, `-2`; extent at same and higher level and at end of file; 2 MiB and non-Markdown; `tests/supervisor/campaign-registry.test.mjs` and `plan-admission.test.mjs`: anchored references accepted, two `#` refused, `docs/.env#x` and `secrets.md#y` refused as secret-like | `scopeDigest` and `authorityDigest` of every synthetic fixture unchanged; every existing test passes unchanged | STA8 merged (`plan.mjs` A5) | No |
| **READ2** | Dispatch resolves anchors into a reading guide; implementer and verifier prompts carry the section 5 wording; verifier `cites` exist and reach the repair packet; brokered research reads the path part | `src/supervisor/controller.mjs` (resolution at dispatch, journal, cite resolution and classification at settle, repair packet references and constraint text); `src/supervisor/adapters/claude.mjs` (prompt text, `cites` in `VERIFIER_SCHEMA`, validator drops bad cites); `src/supervisor/adapters/executors.mjs` (guide passes through `withGateRules`); `src/supervisor/adapters/research-context.mjs` (strip the anchor; ship the section only when resolved); `tests/supervisor/reading-dispatch.test.mjs` (new) | A disposable repository whose fixture document moves a heading between two commits: the implement dispatch resolves, the verify dispatch at the next revision falls back with `missing`, both journalled; a packet with anchors has the same digest whether or not the anchor resolves; an anchor-free declaration's packets and prompts are byte-identical to before (asserted); a verifier result with 4 cites of which one is `../x.md#a`, one `secrets.md#b`, one a missing file and one valid: the verdict stands, three `cite-dropped` reasons, one resolved; the repair packet lists the declared references then the cite, the constraint carries the rule text; a declaration with 24 references gets the cite in text only; classification yields `covered`, `section-miss` and `unreferenced-doc` on three prepared implement packets; `implementerReadAnyway` true, false and null from three report shapes; AGY web task with anchors dispatches without a guide; a `plan` operation's packet is untouched | No `invalid-result` can arise from `cites`; no dispatch is blocked by resolution; the worker-context policy and packet schema are unchanged | READ1; STA10 and STA14 merged (controller turn; STA10 also executors); MOD5 merged | No |
| **READ3** | Sibling carry-forward; coordinator marks sections; status and baseline report the numbers | `src/supervisor/controller.mjs` (7.3 guide extension from this campaign's `section-miss` and `unreferenced-doc` events, bounded); `src/supervisor/coordinator.mjs` (the one drafting sentence of 5.4, in both drafting prompts); `src/supervisor/adapters/executors.mjs` (`PLAN_RULE`, where STA10 put the planning-step prompt; same sentence); `src/supervisor/api.mjs` (`reading` per task); `src/supervisor/baseline.mjs` (`aiworks-baseline/2`, cohorts, "not comparable"); `tests/supervisor/reading-dispatch.test.mjs`, `tests/supervisor/coordinator.test.mjs`, `tests/supervisor/status.test.mjs`, `tests/supervisor/baseline.test.mjs` | Task B dispatched after task A's `section-miss` on `doc#x` gets `doc#x` in its guide with A's finding id, only when B references `doc` by section; a whole-`doc` sibling and a sibling without `doc` get nothing; at most 4 per document and 8 per dispatch; B's packet digest is what it would have been without A; both coordinator prompts and `PLAN_RULE` contain the sentence and their schemas are unchanged; status `reading` is null for pre-change dispatches; the baseline prints two cohorts on a store with 5+5 finished tasks and "not comparable" with 4+5; the store is byte-identical after `baseline` | Prompt-only; no packet, spec or amendment is written by carry-forward | READ2; MOD6 and STA14 merged (`api.mjs` turn; MOD6 also `status.test.mjs`); STA10 merged (plan prompt); STA12 merged (`coordinator.mjs` turn) | No |
| **UI18** | The Step screen says, in plain words, which rule a returned change broke and which sections the next attempt was given | `src/dashboard/supervisor.mjs`, `src/dashboard/copy.mjs`, `src/dashboard/public/dashboard.js`, `tests/dashboard/work.test.mjs` | Copy for `fallbacks`, `misses` and `extended`; a task with `reading: null` shows nothing new; no document text is served, only path, slug and heading; 320px layout | Lane UI rules; no worker text in the screen | READ3; UI12 | No |

Parked items P1 to P7 (section 10) have no slice. Un-parking one is a new slice proposal with the evidence its entry names, reviewed like any other.
