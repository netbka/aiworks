# Design: approve an outcome once and let AIWorks grow its task graph inside it

**Privacy boundary:** this is a design proposal, not a live installation record. Campaign declarations and approval records stay private under [AW-009](../DECISIONS.md#aw-009---public-commits-contain-no-installation-data). Any proposal to publish declarations through source branches or pull requests is superseded. Merged executable code, explicit owner authorization, scope binding and independent verification remain required.

**Status:** design only, for AIWorks design work. Nothing here is built, enabled or deployed. It implements sections 3.2, 3.3 and 5.1 of [PROJECT_WORKSPACE_PLAN.md](../PROJECT_WORKSPACE_PLAN.md) under the owner's decision D3 (section 8 there). It builds on the merged [PROJECT_CONNECTION.md](PROJECT_CONNECTION.md) (#7) and [ADAPTIVE_SCHEDULER.md](ADAPTIVE_SCHEDULER.md) (#9). Section 8 designs decision D4 as the owner decided it on 2026-10-16 (#32): it is planned, not built.

**Basis:** design notes; implementation status must be checked against the selected runtime revision.

Refs #8, Refs #14, Refs #5.

## 1. What the owner gets

- **Say what you want, once.** In a project, write a result in plain words, or pick a GitHub issue, a pull request or a plan file. AIWorks reads the project and shows a short plan: the outcome, how it will be checked, the main steps, what it may change, which AI providers it may use, and whether the result stops for your review.
- **Plan only, if you just want to look.** A plan-only request changes nothing and starts no work. You can turn it into real work later with one click, as long as the project has not changed in the meantime.
- **Approve once.** After you approve, AIWorks plans, splits, assigns, checks, repairs and retries on its own. It adds new steps when the work needs them. It does not ask you to approve each step.
- **It can't quietly do more than you approved.** A new step may never change files outside what you allowed, use a provider or permission you did not allow, publish somewhere else, release, raise your limits, or change what "done" means. If the work needs any of that, only the affected step stops, and you get one clear question.
- **Honest states.** For a GitHub project you see the real steps before work starts: plan file opened for review, checked, merged, started. For a project without GitHub you never see a fake pull request. You confirm its rules once and approve its plan in the dashboard, with no GitHub step and no signing key (section 8, decided 2026-10-16). Until that is built, the dashboard says starting work there is not available yet.
- **Nothing is merged or deployed by this design, and nothing reaches your folder until you press Apply.** Results stop at a verified pull request, or at a verified local candidate that you review and apply yourself (section 8.6). Release is a separate, separately approved mode (#13).

## 2. Where things stand today (observed)

The design was first written before slices E1 to E7, E9 and E10 were built. Every row below was re-checked against the code in this tree on 2026-10-16; a row marked *(since built)* describes code that was added after the design.

| Area | Current behaviour | Evidence |
| --- | --- | --- |
| Campaign | One JSON declaration, validated once. Its declared tasks (1 to 32) are fixed when it is registered. | `src/supervisor/campaign.mjs:1-3`, `:180-181`; `src/supervisor/api.mjs:35-37` |
| Immutable scope | `scopeDigest` covers everything except `authorization`, `limits`, `purpose` and task `outcome`. `authorityDigest` covers the whole declaration. | `src/supervisor/campaign.mjs:68-75` |
| Changing a campaign | A different scope is refused with `SCOPE_CONFLICT`. The executor may change only while paused with no open operation. A lower authorization version is refused. Any other edit needs `authorization.version + 1`, which replaces the stored declaration. | `src/supervisor/api.mjs:44-59`, `:100-101`; `docs/SUPERVISOR.md:13`, `:468` |
| GitHub assumptions | `authorization.reference` must be a GitHub URL, `target.repository` must be `owner/name`, and every campaign and task needs an issue number. | `src/supervisor/campaign.mjs:114`, `:123`, `:125`, `:215` |
| Registration | `cli.mjs start <file>` reads a declaration from any path. Only a **new** campaign is checked against the governance registry. Dashboard Resume restarts a paused campaign from its stored declaration. | `src/supervisor/cli.mjs:119-127`; `src/supervisor/campaign.mjs:444-451`; `src/dashboard/supervisor.mjs:701-706`, `:729-732` |
| AW-005 | Decided: campaigns run only from merged code and a private approved declaration. *(since built)* New work, a coordinator read and a dashboard Resume wait while the runtime revision is not an ancestor of `origin/main`. | `docs/DECISIONS.md:23-25`; `src/supervisor/provenance.mjs:15-27`; `src/supervisor/controller.mjs:542-544`, `:677-686`; `src/supervisor/coordinator.mjs:377-378`; `src/supervisor/cli.mjs:106-109`; `src/dashboard/supervisor.mjs:701-706` |
| Duplicate work (#5) | *(since built, scope A)* Registering a new campaign is refused with `WORK_ALREADY_ASSIGNED` when one of its tasks is already owned by another campaign. | `src/supervisor/api.mjs:24-28`; `src/supervisor/work-ownership.mjs:33` |
| Coordinator | Read-only by allowlist. It answers owner messages and may return a draft declaration as a **string** (`proposedCampaign`). *(since changed)* Replies, plans and drafts are stored locally and shown in the dashboard; nothing is posted to GitHub. It reads its own AIWorks checkout, and other repositories only through read-only `gh` commands. A changed checkout is a boundary violation. Its prompt asks for a run cap and a cost ceiling in drafts. | `src/supervisor/coordinator.mjs:1-4`, `:28-50`, `:76-91`, `:150-178`, `:292-299`, `:326-347`, `:508-512` |
| Coordinator config | Needs 1 to 10 GitHub `owner/name` repositories. A GitHub `reportTo` issue is still accepted, but no reply uses it. | `src/supervisor/coordinator.mjs:133-136` |
| Task specs | *(since built, slice E1)* Every controller path reads a task's spec through one accessor: the declared task, else the live child revision in `task_specs`. | `src/supervisor/plan.mjs:1-5`, `:27-39`; `src/supervisor/controller.mjs:337-338` |
| Packets | Built at dispatch from the declaration: goal, campaign + task constraints, task acceptance, revision-pinned references and governance values. `authorityDigest(decl)` is bound in for a declared task. The packet digest is SHA-256 of the canonical packet. | `src/supervisor/controller.mjs:2058-2075`, `:2090`; `scripts/lib/worker-context.mjs:74-109` |
| Admission check | *(since built, slice E4)* `planContext` gets `authorityCurrent` from the plan binding, recomputed from the plan rows before every dispatch. A failure raises B2 `plan-integrity` and dispatches nothing. | `src/supervisor/controller.mjs:1881-1909`, `:1921-1928`, `:2173-2174`; `scripts/lib/worker-context.mjs:118` |
| Idempotency | Operation id `campaign.task.kind.seq` is also its `idempotency_key`, which is `UNIQUE`. | `src/supervisor/controller.mjs:1999`, `:2151-2152`; `src/supervisor/store.mjs:38-44` |
| Fencing | Every controller write runs in `BEGIN IMMEDIATE` after `assertLease`. A lease is taken over only after expiry, with generation + 1. Dispatch re-reads the campaign version inside that transaction. | `src/supervisor/controller.mjs:505-514`, `:1912-1918`; `src/supervisor/store.mjs:214-229`, `:296-330` |
| Store growth | New tables are added with `CREATE TABLE IF NOT EXISTS`; the store version stays 1. | `src/supervisor/store.mjs:10`, `:19-150`, `:179-181`, `:279-283` |
| Boundary violation | A worker that leaves its boundary is never retried on the same provider; the task waits for the owner (B3). | `src/supervisor/controller.mjs:1083-1085` |
| Reports | A verified report is posted as a marked comment on the task's issue. | `src/supervisor/controller.mjs:2292-2315` |
| Slots | One open operation per campaign while the scheduler is off, which is the default. | `src/supervisor/controller.mjs:1914-1918`; `src/supervisor/campaign.mjs:132`; `docs/SUPERVISOR.md:190` |

**What this means:** when this design was written, the owner hand-wrote a complete, fixed task list, and nothing could add a task without a new campaign. The coordinator could draft, but only as free text that nobody validated. Slices E1 to E7, E9 and E10 have since added child tasks, validated drafts and private approvals (rows marked *since built*; adaptive planning stays behind its own switch). What is still missing is a way to start and finish work on a project without GitHub (section 8).

## 3. Intake: from a request to a draft plan

### 3.1 The five routes

| Route | Available when | What is pinned | What the owner gives |
| --- | --- | --- | --- |
| **Describe a result** | Every project | Project base revision: GitHub base-branch SHA, or the local baseline (`project_baselines`, [PROJECT_CONNECTION.md §5.3](PROJECT_CONNECTION.md#53-the-baseline-it-binds)) | Up to 4000 characters of plain text |
| **Use an issue** | GitHub projects only | Base SHA, issue number and its `updated_at` | An issue of the project's own repository |
| **Continue a PR** | GitHub projects only | Base SHA, PR number, head ref and **head SHA** | A PR whose head branch is in the same repository. A PR from a fork is refused (`PR_FROM_FORK`): AIWorks never pushes to another repository. |
| **Use a plan or task file** | Every project | Base revision plus the file's path and blob SHA at that revision | A repository-relative path (`safePath`, `src/supervisor/campaign.mjs:45-46`). Secret-like paths are refused (`scripts/lib/worker-context.mjs:36-40`). |
| **Plan only** | Every project, combined with any route above | Same as the route | A switch. The result is a draft and nothing else. |

Issue, PR and plan-file text is **data, not instructions**, as the coordinator prompts already say (`src/supervisor/coordinator.mjs:263`, `:298`). It can describe work. It cannot set the write scope, providers, limits, release mode or acceptance: those come only from the owner's Review screen (section 4.2).

### 3.2 How the coordinator drafts without registering (AW-004)

1. **Request.** The dashboard's *Start work* screen posts `{ projectId, route, text | reference, planOnly, requestId }` to a new owner route with the existing origin, CSRF and 16 KiB checks (`src/dashboard/server.mjs:85-89`, `:90-95`). The supervisor stores a `work_requests` row with an idempotent `requestId`, exactly as owner messages are stored (`src/supervisor/coordinator.mjs:211-236`). Nothing is dispatched.
2. **Evidence the code gathers, not the model.** Before the coordinator runs, deterministic code resolves and pins: the project and its governance values (`projectGovernance`, `src/supervisor/campaign.mjs:489-496`, or the D2 overlay); the base revision; the issue or PR metadata through the existing read-only reader (`src/supervisor/github-reader.mjs`); and the open campaigns of the same project with their tasks.
3. **Read-only checkout of the target.** The coordinator reads its own AIWorks checkout (`src/supervisor/coordinator.mjs:163-178`). For intake it also gets a detached, read-only checkout of the target at the pinned revision (observed: built, `:180-197`): from the project's checkout for GitHub, from the managed mirror for local projects ([PROJECT_CONNECTION.md §5.2](PROJECT_CONNECTION.md#52-shape)). The existing "checkout still clean at that revision" rule applies to both checkouts (`:150-158`, `:508-512`). No `gh` command is offered for a local project, so it never fails because `gh` is missing.
4. **Structured draft, not a string.** An intake run uses its own output schema: `{ summary, plan, steps[], questions[], declaration }`, where `declaration` is a **declaration object** (section 4.1). The supervisor validates it with `validateDeclaration` and the envelope rules (section 4.3). An invalid draft is retried once with a fresh session, then shown as "AIWorks couldn't draft a plan" with the reason.
5. **Draft stored, never registered.** A valid draft is stored as a `work_drafts` row: request id, version, declaration, `scopeDigest`, `authorityDigest`, pinned revisions and `state = 'draft'`. Revising creates a new draft version. Nothing reads `work_drafts` when scheduling, so a draft cannot run.
6. **Conflicts are computed, not guessed.** Duplicate or overlapping work is found by code: scope A's `findWorkConflict` (planned, F2-DUPLICATE) and the scheduler's write-domain holders ([ADAPTIVE_SCHEDULER.md §4.3](ADAPTIVE_SCHEDULER.md#43-write-domains-and-work-ownership)). The coordinator's text may explain a conflict; it never decides one.
7. **Not posted to GitHub.** Drafts are shown only in the local dashboard. The coordinator's replies to owner messages are local too: it posts nothing to GitHub (`src/supervisor/coordinator.mjs:299`, `:345`).
8. **Stale drafts.** A draft is stale when its pinned base SHA, baseline, issue `updated_at`, PR head SHA or plan-file blob changed. A stale draft cannot be approved; the owner gets *Plan again*.
9. **Limits.** The current prompt asks the coordinator for a run cap and a cost ceiling (`src/supervisor/coordinator.mjs:295`). Intake drafts leave `limits` out: no limit is the default ([AW-002](../DECISIONS.md#aw-002---campaigns-have-no-capacity-limits-by-default)). Limits appear only when the owner sets them on the Review screen.

The coordinator keeps its role: it reads and proposes. Code stores, validates and decides. The owner approves. The coordinator never registers or changes a campaign.

## 4. The approval envelope

### 4.1 Fields

The envelope is a **version 2 campaign declaration**. Version 1 declarations stay valid and keep their digests. Version 2 adds one block, `envelope`, and relaxes the GitHub-only fields for envelopes as listed below.

```json
{
  "version": 2,
  "campaignId": "sampleapp-chat-search",
  "purpose": "Search inside chats",
  "authorization": { "version": 1, "grantedBy": "owner", "grantedAt": "2026-10-20",
    "reference": "https://github.com/example-org/example-repository "text": "Approved in the AIWorks dashboard: ..." },
  "target": { "tenantId": "example-org", "projectId": "sampleapp", "environment": "development",
    "repository": "example-org/sampleapp", "baseBranch": "main", "trackingIssue": 512 },
  "limits": { "maxCostUsd": 40, "unknownRunCostUsd": 2 },
  "executor": { "kind": "cli-chain", "providers": [ { "kind": "claude-cli", "model": "opus", "permissionMode": "auto" } ],
    "implementerTimeoutMinutes": 240, "verifierTimeoutMinutes": 120 },
  "constraints": [ "..." ],
  "envelope": {
    "scopeVersion": 1,
    "request": { "route": "issue", "reference": "example-org/sampleapp#512", "pinned": { "base": "<40 hex>", "issueUpdatedAt": "2026-10-19T08:00:00Z" } },
    "outcome": "People can search the text of their chats and open the matching message.",
    "acceptance": [ "Searching a word shows every chat message containing it, newest first", "..." ],
    "writes": [ "src/chat/", "src/search/", "tests/chat/" ],
    "denyWrites": [ "src/chat/migrations/" ],
    "deliverables": [ "commit", "report" ],
    "issues": [ 512 ],
    "web": null,
    "release": { "mode": "review-only" },
    "planning": "adaptive"
  },
  "tasks": [ { "id": "T1", "...": "the initial plan the owner saw" } ]
}
```

| Field | Meaning | Rule |
| --- | --- | --- |
| `envelope.outcome` | The result in the owner's words | 1 to 300 characters |
| `envelope.acceptance` | How "done" is checked | 1 to 16 items; becomes the closing check's acceptance verbatim (section 6.6) |
| `envelope.writes` | Path prefixes any step may change | Repository-relative, `safePath`, no secret-like path. Empty means report-only work. Same prefix format as the scheduler's task `writes` ([ADAPTIVE_SCHEDULER.md §4.3](ADAPTIVE_SCHEDULER.md#43-write-domains-and-work-ownership)). |
| `envelope.denyWrites` | Prefixes inside `writes` that stay off limits | Optional |
| `envelope.deliverables` | `commit`, `report` or both | Today's two kinds (`src/supervisor/campaign.mjs:213`) |
| `envelope.issues` | GitHub issues steps may report to | GitHub only; may be empty |
| `envelope.web` | Pages and origins a browser step may open | Today's `web` rules (`src/supervisor/campaign.mjs:264-275`), or `null` |
| `executor` | Providers, models and permission modes (unchanged block) | Today's rules (`src/supervisor/campaign.mjs:143-172`). This is "providers and roles": the role a provider may take is already fixed by deliverable and `web` (`src/supervisor/router.mjs:51-56`). |
| `limits` | Optional owner limits (unchanged block) | Omitted means no limit (AW-002) |
| `envelope.release.mode` | `review-only` | The only accepted value until D5-gate and #13. `auto-release` is refused with `RELEASE_MODE_UNAVAILABLE`. |
| `envelope.planning` | `adaptive` lets AIWorks add steps; `fixed` keeps today's fixed list | |
| `envelope.scopeVersion`, `envelope.supersedes` | 1 for a new outcome; N + 1 for a wider scope that replaces campaign `supersedes.campaignId` | Section 6.7 |
| `envelope.request` | Route, reference and pinned revisions | From the draft; the owner cannot edit it |

**Relaxed for version 2:**

- `target.trackingIssue` and task `issue` are optional. Without an issue, only `commit` deliverables are allowed on a GitHub project, because a report needs a place to be posted (`src/supervisor/controller.mjs:2292-2315`). A local project never has issues; its reports go to the local evidence ledger (slice E10).
- `authorization.reference` is the request's issue or PR URL. For a goal without an issue it is an explicitly authorized request reference; a future local-reference contract remains a design proposal. For a local project it is `aiworks-local:<approvalId>` (section 8), accepted only while local admission is on.
- A local target replaces `repository`, `baseBranch` and `trackingIssue` with `{ source: "local-git" | "folder", baseline: { seq, commit } }`, and `projectId` must be the project's D2 overlay id (`lp-…`).

**Every initial commit task must declare `writes` within `envelope.writes`.** The same admission check as for children applies (section 6.3), so the owner-approved plan and later steps obey one rule.

### 4.2 What the owner sees on Review

The Review screen follows the plan's short preview ([PROJECT_WORKSPACE_PLAN.md §3.2](../PROJECT_WORKSPACE_PLAN.md#32-work-request---one-authorization-autonomous-execution-inside-its-scope-owner-approved-d3)): outcome and checks; main steps and how each is reviewed; conflicts with other work; what may change (`writes`, `denyWrites`), which providers, optional limits and release mode; then **Approve work** or **Revise**. JSON is under details only. Screen layout and copy belong to the owner-workspace design (#11); this design supplies the fields and the state copy (section 7).

The owner may narrow `writes`, add `denyWrites`, remove providers, set limits and edit wording. Editing creates a new draft version and a new digest. The owner may not hand-edit `request`.

### 4.3 Validation

`validateDeclaration` (`src/supervisor/campaign.mjs:96-200`) gains a version 2 branch. It keeps every version 1 rule and adds:

- `envelope` keys are exactly those in 4.1; unknown keys are refused, as today (`:102-104`);
- every initial task passes `validateTask` (today's per-task rules, already extracted unchanged, `:202-261`) and the child admission rules of section 6.3, with the envelope as the boundary;
- a task id may not be `ACCEPT` or `PLAN` (reserved, section 6).

### 4.4 Digests

No new digest function. `scopeDigest` and `authorityDigest` (`src/supervisor/campaign.mjs:68-75`) already cover the new block:

- **Envelope digest** = `scopeDigest(declaration)`. It covers `envelope`, `target`, `executor`, `constraints` and the initial tasks, and is stored as `campaigns.scope_digest` (`src/supervisor/store.mjs:21-27`). Because the existing rules refuse a changed scope (`src/supervisor/api.mjs:44-47`), the envelope cannot change for a registered campaign.
- **Approval digest** = `authorityDigest(declaration)`, which adds `authorization` and `limits`. The owner's approval record binds this value (sections 5 and 8). The dashboard shows its first 12 characters as the plan's fingerprint, under details.
- Version 1 declarations do not contain `envelope`, so their digests do not change. Slice E2 tests every synthetic fixture declaration in `tests/fixtures/campaigns/` against its digest before the change.

## 5. Private approval and registration

An approved work envelope stays in the installation's private approval store. Its declaration and authorization text never enter AIWorks source branches or pull requests. Merged runtime code remains required under AW-005.

| Step | What happens | Owner-facing state |
| --- | --- | --- |
| Approve | Bind the explicit operator approval to the draft version, authority digest, timestamp and request identity. | Approved |
| Persist | Store the exact declaration privately, outside the public commit scope. Validate its shape, target governance and authorized bounds. | Approved |
| Verify authority | Compare the approved digest with the private declaration. A mismatch requires an authorized amendment; no source PR is created. | Ready to start, or approval differs |
| Register | Explicit operator registration uses the private declaration and the existing registry, immutable-scope, authorization-version and duplicate-work gates. | Starting, then Running |

Dashboard-generated envelope approval remains a proposed feature; it must preserve the same authority binding before it is enabled. The existing CLI already registers a private local declaration. Restart and Resume use stored authority without publishing it. Task implementation and verification continue through isolated worktrees and target-project pull requests; campaign declarations remain private.

## 6. Child tasks inside the envelope

### 6.1 What changes and what stays

- The declaration, its `scopeDigest` and its `authorityDigest` **never change** when a child is added. `campaignStart` with the same file stays idempotent (`src/supervisor/api.mjs:100-102`), and `SCOPE_CONFLICT` keeps protecting the envelope (`:44-47`).
- Children live in two new, additive tables. They are bound to the envelope digest by a hash chain, admitted only by deterministic code, and checked again before every dispatch.
- Declared tasks stay as approved. An amendment can **add** children and **revise or cancel children that have not started**. It cannot revise or cancel a declared task, and it cannot touch `ACCEPT` (6.6).

### 6.2 Where proposals come from

A proposal is the structured output of a **planning step**. That is an operation of kind `plan` on the reserved task `PLAN`, run by deterministic code under the campaign lease like any other operation. It uses a fresh session, read-only access and a validated packet. It reuses the packet contract unchanged: role `implementer`, access `read-only`, stage `plan`, which is allowed today for report work (`src/supervisor/controller.mjs:2044-2045`; `scripts/lib/worker-context.mjs:85-86`).

A planning step runs only on an event, never on a timer:

1. registration of an `adaptive` envelope whose initial plan the coordinator marked as incomplete (`questions` non-empty in the draft);
2. a task finishing with `followUps` in its structured result: an optional list of `{ title, reason }` that implementers and verifiers may return, which is data only;
3. the closing check `ACCEPT` reporting acceptance items that no evidence covers (6.6).

Planning steps count as worker runs under the owner's limits, if any (AW-002), and follow the same provider chain and waits.

Its result adds one field to the report result: `amendment = { basis, ops[], rationale }`. `basis` is the plan head digest the planner saw. `ops` contains up to 16 operations:

- `{ "op": "add", "task": { … } }`
- `{ "op": "revise", "taskId": "C3", "task": { … } }`
- `{ "op": "cancel", "taskId": "C2", "reason": "…" }`

### 6.3 Admission checks against unchanged boundaries

Admission is one pure function, `admitAmendment({ envelope, specs, holders, ops, basis })`. It runs inside the same fenced transaction that settles the planning operation (`src/supervisor/controller.mjs:1002-1049`, observed: built). Either the operation finishes **and** the amendment is admitted with its task rows, or neither happens. A refusal names the first failing check and the operation index.

| # | Check | Refusal code | Kind |
| --- | --- | --- | --- |
| A0 | The proposal comes from a finished `plan` operation of this campaign, with a valid structured result, under the current lease generation. | `NOT_A_PLAN_RESULT` | replan |
| A1 | `basis` equals the current plan head; the envelope digest equals `campaigns.scope_digest`; the authorization version equals the current one; the code revision is merged (F1). | `STALE_PLAN` | replan |
| A2 | Idempotency key not seen before (6.4). A repeat returns the earlier amendment unchanged. | (no refusal) | — |
| A3 | Each task passes `validateTask`; its id is new for this campaign, cancelled ids included; `dependsOn` names existing, non-cancelled tasks; the graph stays acyclic; at most 128 tasks per campaign in total. | `INVALID_TASK`, `SCOPE_GROWTH` | replan, or owner for growth |
| A4 | **Files:** a commit task has `writes`. Every prefix lies inside `envelope.writes` and outside `envelope.denyWrites`. Paths are compared after normalising `\` to `/`, removing trailing `/` and folding case (Windows). `safePath` applies, and no secret-like path is allowed. | `WIDEN_FILES` | owner |
| A5 | **Capabilities:** `deliverable` is in `envelope.deliverables`; `web.urls` and `web.resourceOrigins` are within `envelope.web`; `references` are safe paths that are not secret-like. | `WIDEN_CAPABILITY` | owner |
| A6 | **Permissions and providers:** the task has only `validateTask` keys. `executor`, `providers`, `model`, `permissionMode`, `researchOnly`, `role` and `access` are refused by name. | `WIDEN_PERMISSION` | owner |
| A7 | **Destination:** no `target`, `repository`, `baseBranch`, `projectId` or `environment` key; `issue`, when given, is in `envelope.issues`. | `WIDEN_DESTINATION` | owner |
| A8 | **Release mode:** no `release`, `merge`, `deploy`, `apply` or `publish` key; deliverables stay `commit` or `report`. | `WIDEN_RELEASE` | owner |
| A9 | **Limits:** no `limits`, `slots`, `maxCostUsd` or similar key; children cannot change campaign limits. | `WIDEN_LIMITS` | owner |
| A10 | **Acceptance:** no operation names `ACCEPT` or a declared task. Each child's own `acceptance` list (1 to 16 items) only adds checks for that child. | `WIDEN_ACCEPTANCE` | owner |
| A11 | **Constraints:** a child's constraints add to the campaign's, within today's limit of 24 together (`src/supervisor/campaign.mjs:237`), counting the one constraint the envelope adds (6.5). | `INVALID_TASK` | replan |
| A12 | **Duplicate work (#5):** the child's fingerprint and optional `workKey` are not owned by another active campaign (`findWorkConflict`, F2) and do not repeat a live child of this campaign. Overlap with a write domain held elsewhere is not refused; the scheduler waits for it. | `DUPLICATE_WORK` | that op is dropped; the rest continue |
| A13 | **Injected content:** every text field is within its length limit, contains no control characters, and passes the coordinator's credential check (`containsSecret`, `src/supervisor/coordinator.mjs:106-111`). | `UNSAFE_TEXT` | replan |

**Refusal handling:**

- *replan*: the amendment is not admitted, the journal records `amendment-refused` with the code, and the next planning step gets the refusal as a constraint. After 4 refusals in a row with no task finished in between (the existing `NO_PROGRESS_LIMIT`, `src/supervisor/controller.mjs:42`), the campaign raises B3 *stalled*.
- *owner*: a widening is never retried and never admitted in part. The supervisor raises one B3 owner decision (OWNER_INTERVENTION.md) with the exact widening, such as "wants to change `src/billing/`", and two actions: *Approve wider scope* (section 6.7) or *Keep current scope*. Other in-scope work keeps running. Only the steps that would depend on the refused child wait.

**What no check can prove:** whether a child's *goal text* stays faithful to the outcome. That is bounded three ways instead. A child plans its files inside `writes`. Every child packet carries the approved outcome as a constraint (6.5). And the changed paths of each commit are checked after the run: since [AW-013](../DECISIONS.md#aw-013---planned-files-are-a-plan-not-a-stop) a path outside the child's `writes` goes to the verifier, who judges it, and only a secret-like path or one inside `denyWrites` is a boundary violation (B3; the changed-path check is the scheduler's S3). The closing check `ACCEPT` and its independent verifier judge the outcome against the original acceptance.

### 6.4 Storage, idempotency across crash and retry, and fencing

```sql
CREATE TABLE IF NOT EXISTS plan_amendments (
  campaign_id TEXT NOT NULL, seq INTEGER NOT NULL, parent_digest TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE, scope_digest TEXT NOT NULL, authorization_version INTEGER NOT NULL,
  source_operation TEXT NOT NULL, source_packet_digest TEXT NOT NULL, lease_generation INTEGER NOT NULL,
  code_revision TEXT, ops TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, seq));
CREATE TABLE IF NOT EXISTS task_specs (
  campaign_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL, amendment_seq INTEGER NOT NULL,
  spec TEXT NOT NULL, spec_digest TEXT NOT NULL, fingerprint TEXT NOT NULL, cancelled_at INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, task_id, revision));
```

- **Append-only.** Rows in `plan_amendments` are only inserted. A revision of a child is a new `task_specs` row with `revision + 1`. A cancel sets `cancelled_at` on the live revision and moves the `tasks` row to a new state, `cancelled`, which is not runnable (`src/supervisor/controller.mjs:58`). Nothing is deleted.
- **Hash chain.** `digest = sha256(canonicalJson({ campaignId, seq, parent: parent_digest, scopeDigest, authorizationVersion, sourceOperation, sourcePacketDigest, ops }))`. The `parent_digest` of seq 1 is the envelope digest. The plan head is the latest digest, or the envelope digest when there is no amendment.
- **Idempotency key** = `sha256(campaignId, sourceOperation, canonicalJson(ops))`, unique. An operation is settled once (`src/supervisor/store.mjs:40`). After a crash its result is read again from `result.json` and settled with the same key. A different planning operation proposing the same child is stopped by A3 (same id) or A12 (same fingerprint).
- **Crash windows.** Crash before the settling transaction commits: the operation is still open, and reconcile settles it later with the same key. Crash after: the operation is finished and nothing is applied twice. Slice E3 tests both with the controller's fault injection (`src/supervisor/controller.mjs:439-444`) at new points `after-plan-settle` and `before-plan-settle`.
- **Fencing.** Admission runs in `fenced(ctx)`. A controller whose lease generation is stale gets `FencedError` and writes nothing (`src/supervisor/store.mjs:325-330`). `lease_generation` and `code_revision` are recorded for audit.
- **Retries reuse ownership and revision.** A child's attempts, repair rounds, worktree, branch `campaign/<id>/<task>` and base SHA are the existing per-task rows (`src/supervisor/store.mjs:31-37`; `src/supervisor/adapters/git.mjs:25-39`). Retrying a child after a crash reuses them. It never re-admits the child.
- **One accessor.** `specOf(store, campaignId, taskId)` returns the declared spec or the live child revision. It replaces each `decl.tasks.find` in the controller and in status (section 2). `ACCEPT` and `PLAN` are generated from the envelope by the same accessor.

### 6.5 Packet digests for children

- **Declared tasks:** the packet is unchanged, including `authorityDigest = authorityDigest(decl)` (`src/supervisor/controller.mjs:1885`). Running campaigns keep their packet digests.
- **Children:** `authorityDigest = sha256(canonicalJson({ authority: authorityDigest(decl), amendment: <digest of the amendment that set this spec revision> }))`. This is still a 64-hex value, so the packet schema and `acceptsLease` do not change (`scripts/lib/worker-context.mjs:14-15`, `:162-168`). A revised child gets a new digest, which forces a fresh session (`docs/WORKER_CONTEXT_LIFECYCLE.md:47`).
- **Packet content:** goal, acceptance and references come from the child spec. Constraints are the campaign's, then one envelope constraint ("Approved outcome: …. Planned files: …", with the AW-013 rule for a file beyond them), then the child's own, then verifier findings, as today (`src/supervisor/controller.mjs:2066-2071`).
- **Checked again before every dispatch.** Inside the fenced dispatch transaction, before the operation is recorded, the controller (1) recomputes the chain from the rows, (2) re-runs A3 to A11 for the live spec against the envelope, and (3) for a local project, re-verifies the approval and ledger (section 8). Any failure raises B2 `plan-integrity` and dispatches nothing. The result is the real `authorityCurrent` input to `planContext` (observed: built, `src/supervisor/controller.mjs:2173-2174`).

### 6.6 The closing check and parent ownership

Every envelope gets a generated task `ACCEPT`: a read-only `report` whose acceptance is `envelope.acceptance`, verbatim. Its `dependsOn` is every other non-cancelled task, computed when it is scheduled. It maps each acceptance item to evidence: verified SHAs, PRs, reports and local candidates. It lists anything not covered. Its own independent verifier checks that mapping. This is #5 scope C ("accepting one PR must not close the parent") inside the Task Controller that already owns the campaign. It is not a new agent.

If items remain uncovered, a planning step runs (6.2). If two closing checks in a row report the same uncovered items with no task finished in between, the campaign raises B3: "This can't be finished within what you approved: {items}." The campaign is *ready* only when `ACCEPT` passes. Its report goes to `trackingIssue` when there is one. Otherwise it goes to the dashboard (GitHub without an issue) or to the local evidence ledger.

### 6.7 How it meets the immutable `scopeDigest` and #5 work ownership

- **Immutable scope stays immutable.** A wider scope is a new envelope: `scopeVersion + 1` and `supersedes: { campaignId, scopeDigest }`. It goes through the same approval and main gate (or D4). When it registers, the old campaign is cancelled through the existing cancel path once it has no open operation (`src/supervisor/api.mjs:651-653`). Its done tasks become dependency evidence of the new one. Its published but unmerged PRs keep their write domains until merged or closed ([ADAPTIVE_SCHEDULER.md §4.3](ADAPTIVE_SCHEDULER.md#43-write-domains-and-work-ownership)).
- **Executor amendments** may still change `scope_digest` (`src/supervisor/api.mjs:41-47`). Children stay valid only if the new declaration differs from the old one in `executor` alone, using the same test as `api.mjs:44-45`. The journal records `plan-rebound` with both digests.
- **Work ownership.** F2's `findWorkConflict` reads declarations. Slice E3 extends it to read live `task_specs` too, so a child is visible to other campaigns' registration exactly like a declared task. The scheduler's `domainHolders` reads children through `specOf`. A child's `writes` is its write domain, as the scheduler design already expects ([ADAPTIVE_SCHEDULER.md:140-141](ADAPTIVE_SCHEDULER.md#43-write-domains-and-work-ownership)).

### 6.8 The widening test matrix

Each row is a test in `tests/supervisor/plan-admission.test.mjs` (pure, no process) unless marked. One property test also generates random amendments and asserts: admitted implies every boundary is a subset of the envelope.

| A child tries to widen | Proposal in the test | Must return |
| --- | --- | --- |
| Files | `writes: ["src/billing/"]` outside `envelope.writes`; `"SRC/Chat/../billing"`; `"src\\chat\\x"` inside `denyWrites`; a commit task with no `writes`; `".env.local"` | `WIDEN_FILES`, or `INVALID_TASK` for an unsafe path |
| Files, after the run (controller test with disposable Git repository) | Implementer commits a file outside its `writes` | Boundary violation, B3, not retried on that provider |
| Capabilities | `deliverable: "report"` when only `commit` is allowed; `web.urls` with a new origin; a reference to `config/secrets.json` | `WIDEN_CAPABILITY` |
| Permissions and providers | `permissionMode: "bypassPermissions"`; `executor: {...}`; `model: "x"`; `access: "write"` on a report | `WIDEN_PERMISSION` |
| Destination | `repository: "example-org/other"`; `baseBranch: "release"`; `issue: 999` not in `envelope.issues` | `WIDEN_DESTINATION` |
| Release mode | `release: { mode: "auto-release" }`; `deploy: true` | `WIDEN_RELEASE` |
| Limits | `limits: { maxCostUsd: 1000 }`; a 129th task | `WIDEN_LIMITS`; `SCOPE_GROWTH` |
| Acceptance | `revise` of `ACCEPT`; `cancel` of declared `T1`; `revise` of a child already implementing | `WIDEN_ACCEPTANCE`; `INVALID_TASK` for the started child |
| Duplicate work | Same `workKey` as an active task of another campaign | `DUPLICATE_WORK`, no worker run spent |
| Chain tampering (controller test) | An edited `task_specs.spec` row; a deleted amendment row | B2 `plan-integrity`, nothing dispatched |

## 7. Owner-facing states

The copy is exact owner-facing English (D9). `{…}` are placeholders. Screens and layout belong to the #11 design; it does not restate them here. Each state is derived from stored rows or read-only `gh` data, never assumed. Unknown is shown as unknown.

### 7.1 Before work starts

| Code | State | Copy | Action |
| --- | --- | --- | --- |
| `DRAFTING` | Drafting a plan | AIWorks is reading {project} and drafting a plan. Nothing changes yet. | — |
| `DRAFT_READY` | Plan ready | Here's what AIWorks would do, what it may change and how it will be checked. | Approve work |
| `PLAN_ONLY_READY` | Plan ready (plan only) | This plan changes nothing. You can start it while {project} stays at {sha7}. | Start this work |
| `DRAFT_FAILED` | Couldn't draft a plan | AIWorks couldn't draft a plan: {reason}. | Try again |
| `DRAFT_STALE` | Plan out of date | {project} changed since this plan was drafted ({what}). Draft it again before approving. | Plan again |
| `CONFLICT` | Overlaps other work | "{campaign}" is already doing {task}. Approve anyway and this step will wait for it, or remove the step. | Review |
| `APPROVED` | Approved | Your approval is saved. Work starts after the plan file is added to AIWorks's main branch. | — |
| `DECLARATION_TO_OPEN` | Plan file ready (until Q3) | The plan file is ready. Open it as a pull request on branch declare/{id}. | Copy plan file |
| `DECLARATION_REVIEW` | Plan file in review | The plan file is in pull request #{n}. It's being checked. | Open PR #{n} |
| `DECLARATION_READY` | Ready to merge | The plan file passed its checks. Work starts when it's merged; AIWorks doesn't merge by itself. | Open PR #{n} |
| `DECLARATION_DIFFERS` | Plan file differs from your approval | Pull request #{n} no longer matches what you approved, so AIWorks won't start it. | Review changes |
| `DECLARATION_CLOSED` | Plan file closed | Pull request #{n} was closed without merging. Nothing started. | Approve again |
| `READY_TO_START` | Ready to start (until slice E8 is switched on) | The plan file is merged. Start the work to let AIWorks begin. | Start work |
| `STARTING` | Starting | Merged at {sha7}. AIWorks is starting the work. | — |
| `START_REFUSED` | Couldn't start | AIWorks didn't start this work: {reason}. | {action from reason} |
| `GITHUB_UNKNOWN` | Can't check GitHub | GitHub can't be reached, so AIWorks doesn't know the state of pull request #{n}. It will check again. | Check again |
| `LOCAL_START_OFF` | Not available yet | You can plan work here. Starting work on projects without GitHub isn't built yet. | — |
| `LOCAL_RULES_NEEDED` | Confirm this project's rules | Before work can start here, confirm the rules this project follows. You do this once; it lasts up to 12 months. | Review rules |
| `LOCAL_APPROVAL_REFUSED` | Couldn't approve | AIWorks couldn't confirm this approval came from you in this browser, so nothing started. | Approve again |

`START_REFUSED` reasons: `DECLARATION_DIFFERS_FROM_APPROVAL`, `DUPLICATE_WORK` with the other campaign, `REGISTRY_*` from [PROJECT_CONNECTION.md §8.2](PROJECT_CONNECTION.md#82-github-project), and `RUNTIME_NOT_MERGED` (F1).

### 7.2 While work runs

| Code | State | Copy | Action |
| --- | --- | --- | --- |
| `STEP_ADDED` | (notice in the work view) | AIWorks added a step: {title}. It stays within what you approved. | Open step |
| `SCOPE_DECISION` | Needs your decision | This work needs more than you approved: {widening}. Other steps continue. | Approve wider scope / Keep current scope |
| `CANT_FINISH` | Needs your decision | AIWorks can't finish this within what you approved: {items} aren't covered. | Review |
| `PLAN_INTEGRITY` | Stopped | AIWorks's record of this plan doesn't add up, so it stopped starting steps. Nothing was lost. | Check again |
| `CANDIDATE_READY` (local) | Ready for your review | Verified at {sha7}. It's not applied to your folder. | Review result |

`SCOPE_DECISION` → *Keep current scope* cancels the refused child (an owner-made amendment with `source_operation = owner:<requestId>`). Work continues without it. *Approve wider scope* opens a new draft with `scopeVersion + 1`, pre-filled with the widening, and goes through section 5 or section 8.

## 8. Decision D4: local admission without GitHub

**Decided by the owner on 2026-10-16 (#32).** The owner said: "This AIworks should work with no dependency on Github." Approving a plan in the local dashboard admits exactly that plan, bound to its digest. There is **no signing key**. Nothing in this section is built yet (planned).

### 8.1 The problem

AW-005 requires merged executable code and an explicitly registered private declaration. Today the only way to register one is the owner's `cli.mjs start` (`src/supervisor/cli.mjs:106`, `:119`), and the declaration format needs a GitHub authorization URL and a GitHub repository (`src/supervisor/campaign.mjs:114`, `:123`). Every local target is refused (`src/supervisor/campaign.mjs:355-358`). A project without GitHub therefore has no way to start work. The decision gives it one: the owner's approval in the dashboard.

### 8.2 Threat model

**Who the boundary is.** AIWorks, its workers, its dashboard and the owner's own tools run under the **same Windows account**. Anything that account can run could, in principle, write the supervisor store (`supervisor.db`) or send a request to the dashboard. Claude's deny rules are not an operating-system boundary (governance Constitution §9). A hash chain in the store alone is not tamper-evident against that account: a full rewrite can recompute it.

**What the owner chose.** With no signing key, AIWorks cannot prove that the owner was present for an approval. The design does not claim to. It names who could try to forge an approval and what stops each of them:

| Who | What they could try | What stops it |
| --- | --- | --- |
| A web page open in the owner's browser | Send an approval to the dashboard | The dashboard listens on `127.0.0.1` only (`src/dashboard/main.mjs:34`). It refuses any other host or origin (`src/dashboard/server.mjs:54-55`). A command needs the exact origin and a CSRF token (`:85-88`), JSON (`:89`) and at most 16 KiB (`:90-95`). (Observed in code.) |
| An AIWorks worker or the coordinator, for example after a prompt injection | Open the dashboard in its browser | A browser worker may not name the dashboard's port 4318 (`src/supervisor/campaign.mjs:271-273`, observed). |
| The same, from a shell | Read the CSRF token with a plain GET (a non-browser client can omit the `Origin` header) and send the approval | Planned **caller check**: the approval and rules routes find the process at the other end of the loopback connection and refuse it when that process belongs to AIWorks's own process tree. On Windows every worker and coordinator run starts through `runner.mjs` (`src/supervisor/controller.mjs:36`, `src/supervisor/coordinator.mjs:20`) inside a job object AIWorks creates for that run, which its descendants cannot leave (`src/supervisor/windows-process.ps1:88-96`, `:116-117`: no breakaway flag; observed). The check asks whether the caller is in the job of an open run. The refusal is `APPROVAL_FROM_AIWORKS`. Where the check cannot run (another platform, or the lookup fails), the route refuses with `APPROVAL_UNCHECKED`: it fails closed. |
| The same | Write an approval straight into `supervisor.db` | **Detected, not prevented.** Every approval is journaled by the dashboard route with its request id, and appended to the ledger (8.4). The supervisor re-checks the ledger before every dispatch. The owner sees every approval, with its time and fingerprint, in the project's history and can revoke it. A worker's writes outside its worktree are outside its packet; whether they are noticed is **unknown** today. |
| Any program the owner runs with full rights | All of the above | **Not stopped.** Such a program can already change the owner's folders and AIWorks's data directly, so an approval gives it no write it lacks. What it could gain is AI work in the owner's name, which shows up as above. This is the residual risk of choosing no key. |

**What an approval can admit.** Even a forged approval admits only one plan that already exists as a draft, inside its own envelope: the boundaries of section 6 are checked again before every dispatch. It can never merge, deploy or write the owner's folder: applying a result needs the owner's own Apply (8.6), which repeats the caller check.

**Code is still the other risk.** Unmerged controller code must never admit new execution ([AW-005](../DECISIONS.md#aw-005---runtime-code-must-be-merged-declarations-remain-private)). D4 does not reopen that.

### 8.3 Decision text

Slice E12 records this as a new decision with the next free AW number. It quotes the owner's words of 2026-10-16 and does not change AW-001 to AW-007 as written.

> **Local projects start from an owner approval in the dashboard (D4, owner decision 2026-10-16)**
>
> All campaign declarations remain private. Merged, reviewed executable code and explicit owner authority stay required for every project.
>
> A campaign whose target is a connected **local project** (Local Git or plain folder, D1) is registered when the owner approves its plan in the local dashboard. The supervisor checks each point below at registration, at resume and before every dispatch, and fails closed:
>
> 1. **Merged, reviewed, pinned code.** The supervisor runs from a reviewed revision, deployed by the documented upgrade procedure. Any change to `src/supervisor` had independent approval of its exact head. Nothing in an approval or declaration is executed as code.
> 2. **Owner approval in the dashboard.** The owner reviews the plan on one screen and presses *Approve and start*. The approval record (8.4) binds that exact plan by its digest. There is no signing key.
> 3. **From the owner, not from AIWorks.** The dashboard refuses an approval that comes from a process AIWorks started, and refuses when it cannot tell (8.2).
> 4. **Governed project.** The target has an admissible local overlay entry ([PROJECT_CONNECTION.md §7](PROJECT_CONNECTION.md#7-decision-d2-the-rules-a-project-without-github-follows)), and the approval binds that entry's digest. A project with a GitHub remote can never use this path.
> 5. **Append-only ledger.** The approval, every child amendment of that campaign and every revocation are appended to a local hash-chained ledger. A break or a missing entry stops new dispatches for the affected campaigns (B2) until the owner approves again.
> 6. **Same limits as every campaign.** Child tasks follow the same envelope admission. The supervisor never merges, deploys or writes the owner's folder by itself ([AW-001](../DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception)). A local result is a verified local candidate. Only the owner's *Apply* writes it to the folder.
> 7. **Revocation.** Revoking or expiring the project's overlay entry, or the owner's *Revoke*, stops new dispatches at the next check. Running operations finish and are recorded, as with a pause.
>
> This changes where an owner approval may come from, for local projects only. It does not let unmerged code run, and it does not change the GitHub path.

**Which main is trusted.** The owner also decided on 2026-10-16 that AIWorks's own **local main** is the trusted source of its code, and GitHub is an optional mirror. AW-005 today names `origin/main`, and the provenance check reads it. Moving that check to local main needs its own decision record and slice, which this design does not contain (plan §6.13, G9). Until then point 1 means what AW-005 says today.

### 8.4 The evidence that binds an approval

| Evidence | What it binds | What it defeats |
| --- | --- | --- |
| **Approval record** `aiworks-local-approval/1`: `{ approvalId (UUID), campaignId, projectId (lp-…), overlayDigest, declarationDigest = authorityDigest(declaration), codeRevision, approvedAt, startBy (≤ 30 days), nonce }`, as `canonicalJson`, with method `owner-local-ui` | The exact plan, project, rules and code revision at approval | A different plan, project or rules set reusing the approval |
| **Request receipt** written by the dashboard route: the request id, the caller-check result (`owner-browser`) and the record digest | That the approval came through the owner route and passed the caller check | An approval row with no matching receipt, which is refused |
| **Single use** | Each `nonce` admits one registration | Replaying an old approval after a revoke |
| **Ledger** table `local_ledger(seq, kind, campaign_id, payload, payload_digest, prev_hash, hash, created_at)`: `kind` is `approval`, `amendment` or `revocation`; `hash = sha256(prev_hash ‖ kind ‖ payload_digest)` | The order and completeness of approvals and amendments | Silently removing or reordering entries by code that does not also rewrite the chain. Unapproved amendments stay bounded by the approved envelope (section 6). |
| **Journal and status** | `local-approval-recorded` with the record digest and ledger head; the project's history shows each approval's date and the plan's fingerprint | Unexplained state; it gives the owner something to check |

Why amendments without a new approval are still safe: one that passes section 6's checks adds only work the approved envelope already allows. One that does not pass is refused at admission **and** again before every dispatch. Widening a local envelope always needs a new owner approval in the dashboard.

### 8.5 What stays the same

- GitHub projects: section 5, unchanged by D4. A local approval naming a project with `source_kind = github` is refused (`LOCAL_PATH_NOT_FOR_GITHUB`).
- Starting work on a local project stays off in code until slice E12 (observed: `src/supervisor/campaign.mjs:355-358`, `src/supervisor/projects.mjs:68-71`). Slice E11 builds everything behind that refusal. Slice E12 lifts it in a reviewed PR that names D2 and D4.

### 8.6 Results: review, then Apply

**Decided by the owner on 2026-10-16.** A finished local result is reviewed in the dashboard and written to the owner's folder only when the owner presses **Apply**. This is an owner action under Review only. It is **not** Auto Release: it needs no release grant, creates no release record and never runs by itself ([AUTO_RELEASE.md §3](AUTO_RELEASE.md#3-the-two-modes)). Nothing here is built yet (planned).

1. **Review.** A verified local candidate shows *Ready for your review* (observed copy: `src/supervisor/local-candidates.mjs:16-20`). The review screen lists every changed file and the independent check's result. Nothing in the folder has changed yet.
2. **Rescan.** When the owner presses *Apply*, AIWorks reads the folder again first. Local Git: the branch head must equal the candidate's baseline commit and the working tree must be clean. Plain folder: every file Apply writes or deletes must still have its baseline hash. If any file changed, Apply refuses with `APPLY_FOLDER_CHANGED`, lists the changed files and writes nothing.
3. **Backup.** Local Git: a ref `refs/aiworks/apply-backup/<apply id>` at the current head. Plain folder: a copy of every file that will change or be deleted, with a manifest of paths and hashes, under AIWorks's data directory. No file is written before the backup is recorded.
4. **Apply.** Local Git: fast-forward only, after the candidate's commit is fetched from AIWorks's mirror into the owner's repository. Plain folder: each file is written to a temporary file in the same directory and renamed over the target; deletions come last.
5. **Confirm.** Every path equals the candidate (Local Git: head equals the candidate and the tree is clean). The result shows *Applied*, with *Undo apply*.
6. **The way back.** *Undo apply* restores the backup only where the folder still equals what Apply wrote. Where the owner has changed a file since, AIWorks stops, keeps the backup and says which files; it never writes over the owner's work.
7. **Crash.** An apply left open by a crash is reconciled by reading the folder, never by repeating it blindly ([AUTO_RELEASE.md §8](AUTO_RELEASE.md#8-restart-reconcile-never-repeat), local rows).

The adapters are the ones AUTO_RELEASE R8 designs (`local-git-apply`, `local-folder-apply`, [§7.5](AUTO_RELEASE.md#75-local-apply-with-a-reversible-backup)), so apply code stays under `src/supervisor/release/`. *Apply* and *Undo apply* go through the same dashboard route rules and caller check as an approval (8.2). Auto Release for a local project stays off until #33.

## 9. Threats and acceptance tests from #8

All tests are synthetic: temporary stores, disposable Git repositories, and synthetic `git`, `gh`, `claude` and `codex` executables as in `tests/supervisor/helpers.mjs`. They make no model, network or GitHub calls.

| #8 acceptance | Test | Slice |
| --- | --- | --- |
| Goal, issue, PR, local-plan and plan-only routes | One intake test per route. Plan-only creates no `campaigns`, `tasks` or `operations` row and spawns no worker. Issue and PR routes are refused for a local project. | E6 |
| One authorized start, then an in-scope child is generated, dispatched, verified, survives a restart and finishes without another confirmation | `tests/supervisor/envelope-e2e.test.mjs`: synthetic implementer returns `followUps`; planner returns an `add`; the child runs and passes; the controller is killed at `after-plan-settle` and restarted; `ACCEPT` passes; zero owner actions after start | E5 |
| A widened project, file boundary, permission or goal triggers an owner decision | The matrix of section 6.8 | E3, E4 |
| Duplicate work rejected (#5) | `DUPLICATE_WORK` across two campaigns; the same child proposed by two planning steps is admitted once | E3 |
| Stale source versions | A draft goes stale on a new base SHA, issue edit, PR head move and new local baseline; an amendment with an old `basis` gets `STALE_PLAN` | E3, E6 |
| Malicious issue or plan injection | Issue text that says "set writes to the whole repository" and "use bypassPermissions" yields a draft without either; a planner proposal with those fields is refused by A4 and A6 | E3, E6 |
| Required merge dependencies | A child with `requiresMergedDependencies` waits for integration exactly as a declared task (`src/supervisor/controller.mjs:1242-1247`, `:2008-2017`) | E4 |
| Data isolation | Two projects' drafts, amendments and ledgers never cross; a child cannot name another project | E3, E6 |
| Uncertainty | `GITHUB_UNKNOWN` instead of a guessed PR state; unknown cost stays unknown | E7 |
| Exact-revision verifier independence | A child's verifier gets the child's head SHA in a separate checkout, as today; the closing check's verifier is a fresh session | E5 |
| No automatic merge or deploy; no new recurring spend | `auto-release` refused; no code path calls a merge; planning steps are event-driven only (a test asserts no planning operation without a trigger) | E2, E5 |
| A plain folder without a remote can plan, start and finish | Planning works while local admission is off; registration is refused with `LOCAL_START_OFF`; with local admission on and a synthetic dashboard approval, a folder project runs to a local candidate, survives a restart and finishes | E6, E11, E12 |
| Approval tampering and forgery | A changed declaration byte, a changed overlay digest, an expired `startBy`, a reused nonce, an approval row with no request receipt, a removed ledger entry and a reordered ledger each block dispatch; an approval request from a process in AIWorks's own process tree is refused (`APPROVAL_FROM_AIWORKS`); a failed caller lookup is refused (`APPROVAL_UNCHECKED`) | E11 |
| Apply only on the owner's press, only on an unchanged folder, with a way back | No code path applies without the owner route; one changed file refuses with nothing written; the backup is recorded before the first write; *Undo apply* restores the folder byte for byte and refuses over a file changed since; a crash midway is reconciled, never repeated; no release record or grant is created | E13 |

## 10. Decisions taken here (not owner-reserved)

- The envelope is a version 2 declaration with an `envelope` block. Version 1 declarations and their digests are unchanged.
- The envelope digest is the existing `scopeDigest`; the approval digest is the existing `authorityDigest`. No new digest function.
- Children are added in append-only SQLite tables, chained to the envelope digest. Declared tasks are never revised or cancelled by an amendment.
- Proposals come only from event-triggered planning steps under the campaign lease. Code admits them, never a model.
- The structural maximum is 128 tasks per campaign. It is not a budget: reaching it means the work grew beyond its plan, which is a scope question for the owner.
- The closing check `ACCEPT` is generated from `envelope.acceptance`; children cannot touch it.
- Drafts stay in the local dashboard; they are not posted to GitHub.
- GitHub registration reads the declaration from `origin/main` history and requires `authorityDigest` equal to the approval.
- `release.mode` accepts only `review-only` until D5-gate and #13.
- Intake drafts carry no limits unless the owner sets them (AW-002).
- A PR from a fork cannot be continued.

## 11. Owner-reserved questions

D1, D3, D5 and D9 are settled and are not asked again. **The owner answered the rest on 2026-10-16 (#32, #24).** Nothing in this section asks the owner any more:

1. **D4.** Accepted in the form of section 8.3: a local project starts from the owner's approval in the dashboard, with **no signing key**.
2. **Does approving a plan in the local dashboard count as your explicit registration of that exact plan?** Yes, bound to the plan's digest. For a GitHub project this lets slice E8 start the work once the plan matches the approval; for a local project, slice E12.
3. **May declarations be published through AIWorks branches or pull requests?** No. AW-009 keeps them private. No supervisor-opened declaration pull request is built.
4. **Which key signs local approvals?** None. The owner chose no key; section 8.2 states what that leaves open.

The rules question that used to be asked with Q2 is answered in [PROJECT_CONNECTION.md §9](PROJECT_CONNECTION.md#9-owner-reserved-questions).

## 12. Implementation slices

Each slice is one reviewable PR. Every change under `src/supervisor/` needs an independent review that approves the exact head before merge ([AGENTS.md](../../AGENTS.md#review-and-runtime-maintenance)). The owners of #5 and `example-foundation` (F1-AW005, F2-DUPLICATE) have priority on `api.mjs` and `campaign.mjs`. Slices that touch `controller.mjs` are sequenced against the scheduler slices S2 to S4 and PROJECT_CONNECTION S3 so that two campaigns never edit it at once. All tests are synthetic, with no network, model or GitHub calls. Each slice ends with `npm run check`. Merged is not deployed: the live runtime changes only through the upgrade procedure ([SUPERVISOR.md §6](../SUPERVISOR.md#6-installation-and-maintenance)).

| # | Outcome | Files it owns | Tests | Acceptance | Depends on | Waits for a decision |
| --- | --- | --- | --- | --- | --- | --- |
| **E1** | Task specs come from one accessor, ready for children; no behaviour change | `src/supervisor/plan.mjs` (new: `specOf`); `src/supervisor/store.mjs` (additive DDL: `task_specs`, `plan_amendments`); `src/supervisor/controller.mjs` and `src/supervisor/api.mjs` (replace `decl.tasks.find`) | `tests/supervisor/plan-specs.test.mjs`: an old store gains the tables with store version 1; `specOf` returns declared specs; status works for a task row absent from the declaration; every existing test passes unchanged | No packet digest of any existing campaign changes (asserted over synthetic fixture declarations) | F1-AW005, F2-DUPLICATE merged; scheduler S2 sequenced | No |
| **E2** | Version 2 declarations with an `envelope` block validate | `src/supervisor/campaign.mjs` (`validateTask` extracted unchanged; v2 branch; reserved ids; `release.mode`); `docs/SUPERVISOR.md` §1 | `tests/supervisor/envelope-schema.test.mjs`: every field rule of 4.1; `auto-release` refused; v1 digests of every synthetic campaign fixture unchanged; initial commit tasks need `writes` within the envelope | v1 behaviour identical; v2 registers through the existing `start` | E1; scheduler S3 (task `writes`) | No |
| **E3** | Children are admitted, chained and idempotent | `src/supervisor/plan.mjs` (`admitAmendment`, chain); `src/supervisor/controller.mjs` (settle `plan` operations); `src/supervisor/work-ownership.mjs` (read `task_specs`) | `tests/supervisor/plan-admission.test.mjs` (matrix of 6.8 + property test); `tests/supervisor/plan-crash.test.mjs` (fault at `before-plan-settle` and `after-plan-settle`; stale lease generation writes nothing; same idempotency key returns the earlier amendment) | Every widening refused with its code; nothing admitted twice after crash or retry | E2; F2-DUPLICATE | No |
| **E4** | Children run with their own packet binding, re-checked before every dispatch | `src/supervisor/controller.mjs` (child packet `authorityDigest`, envelope constraint, `plan-integrity` B2, real `authorityCurrent`) | Controller tests: an edited spec row or a removed amendment blocks dispatch; a revised child gets a new packet digest and a fresh session; out-of-`writes` commit is a boundary violation; `requiresMergedDependencies` child waits like a declared one | Declared tasks' packets byte-identical to before | E3; scheduler S3 (changed-path check) | No |
| **E5** | AIWorks adds steps by itself and closes the outcome | `src/supervisor/adapters/executors.mjs` (plan-stage schema, optional `followUps`); `src/supervisor/controller.mjs` (planning triggers, `PLAN`, `ACCEPT`) | `tests/supervisor/envelope-e2e.test.mjs` (section 9 row 2); no planning operation without a trigger; two identical uncovered closing checks raise B3 | #8 acceptance "one start, child, verify, restart, finish without the owner" passes | E4 | No |
| **E6** | The owner can ask for work by goal, issue, PR or plan file, or plan only | `src/supervisor/intake.mjs` (new: requests, drafts, staleness, conflicts); `src/supervisor/coordinator.mjs` (intake mode, schema, target checkout); `src/supervisor/store.mjs` (additive `work_requests`, `work_drafts`) | `tests/supervisor/intake.test.mjs`: each route; plan-only writes no campaign; injection cases; staleness for each pinned item; fork PR refused; local project without `gh` drafts | Drafts are never scheduled; coordinator checkouts stay clean | E2; PROJECT_CONNECTION S1, S4 (project records, mirror) | No |
| **E7** | An approved GitHub plan can only start as approved | `src/supervisor/approvals.mjs` (new: `envelope_approvals`, declaration rendering, digest compare); `src/supervisor/provenance.mjs` (load the private declaration, retaining merged-runtime enforcement); `src/supervisor/cli.mjs` | `tests/supervisor/approval-private.test.mjs` with a disposable `origin/main`: identical file starts; one changed byte gives `DECLARATION_DIFFERS_FROM_APPROVAL`; unmerged file is not started; revoked private approval starts nothing | No start without matching private approval and merged runtime code | E2, F1-AW005 | No |
| **E8** | The owner approves once in the dashboard and sees each real step | `src/dashboard/work.mjs` (new); `src/dashboard/server.mjs` (routes with origin, CSRF, 16 KiB); `src/dashboard/public/*` (Start work and Review areas only); `docs/OPERATIONS_DASHBOARD.md` | `tests/dashboard/work.test.mjs`: route security; exact copy for every code of section 7; no fabricated PR state; keyboard and 320px checks per UX-001/UX-002 | Approve-to-start needs no CLI (answered: Q2 yes, 2026-10-16) | E6, E7; the #11 design and its file owner | No |
| **E9** | Private declaration persistence and idempotent registration | Private approval store and local declaration loader | Restart preserves the approved digest and registers only once; no declaration branch, PR or upload is created | Campaign data never enters source Git | E7 | No publication authority |
| **E10** | Local projects get verified candidates, never a fake PR | `src/supervisor/local-candidates.mjs` (new ledger of verified revisions and reports); `src/supervisor/controller.mjs` (publish branch for local kinds) | `tests/supervisor/local-candidates.test.mjs`: a verified local task records `{ sha, verifier evidence, baseline }`; `pushVerified` and `gh` are never called; status shows *Ready for your review* | Inert until local admission is on | E4; PROJECT_CONNECTION S4, S5 | No (built; used after E12) |
| **E11** | D4 built and tested, switched off | `src/supervisor/local-admission.mjs` (new: approval record, request receipt, single-use nonce, ledger, revocation, caller check with an injectable process lookup); `schemas/local-approval.schema.json` (new) | `tests/supervisor/local-admission.test.mjs`: every tampering and forgery case of section 9; a synthetic caller in AIWorks's process tree refused; a failed lookup refused; GitHub project refused; with local admission off every approval is refused | Local admission stays off; no store table exists until the first approval | E3, E7, E10; PROJECT_CONNECTION S7 | No (decided 2026-10-16, #32) |
| **E12** | Start work on projects without GitHub | `src/supervisor/campaign.mjs` (accept a local target with an admitted approval and no issue numbers, in place of the refusal at `:355-358`); `src/supervisor/controller.mjs` (a local campaign's reports and blockers stay in the store and Needs me; no issue comment); `src/supervisor/projects.mjs` (`startWork` for local kinds with an admissible overlay, in place of `:68-71`); `src/supervisor/project-connect.mjs` (local capabilities and the `LOCAL_START_OFF` copy); `src/supervisor/local-admission.mjs` (switch on); `docs/DECISIONS.md` (record D4 as in 8.3); `docs/SUPERVISOR.md` | Full local end-to-end with a synthetic dashboard approval: plain folder → rules confirmed → plan approved → child → verified candidate → restart → finish; no `gh` call in the whole run; GitHub tests unchanged | A plain folder without a remote runs to a verified local candidate; GitHub projects unchanged | E11; PROJECT_CONNECTION S7, S8 | No (decided 2026-10-16); the decision record's wording is checked against the owner's words |
| **E13** | The owner applies a verified local result, and can undo it | `src/supervisor/release/owner-apply.mjs` (new: rescan, backup, apply, confirm, undo, reconcile; calls the AUTO_RELEASE R8 adapters) | `tests/supervisor/owner-apply.test.mjs` with temporary folders and disposable Git repositories: the section 9 Apply row; Local Git is fast-forward only and never resets owner work; symlink, junction and outside paths refused; none skipped on Windows | Apply writes only after the owner's press, a clean rescan and a recorded backup; *Undo apply* works; no release record or grant exists | AUTO_RELEASE R8; E10; PROJECT_CONNECTION S5 | No (decided 2026-10-16). Auto Release stays off (#33) |

Slice E13 is the owner's Apply only. Any Auto Release, local or not, belongs to #13 and stays off until #33. The screens for local rules, approval and Apply are OWNER_WORKSPACE S12 (plan UI16, UI17).
