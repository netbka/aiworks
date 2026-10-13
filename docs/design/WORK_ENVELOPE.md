# Design: approve an outcome once and let AIWorks grow its task graph inside it

**Privacy boundary:** this is a design proposal, not a live installation record. Campaign declarations and approval records stay private under [AW-009](../DECISIONS.md#aw-009---public-commits-contain-no-installation-data). Any proposal to publish declarations through source branches or pull requests is superseded. Merged executable code, explicit owner authorization, scope binding and independent verification remain required.

**Status:** design only, for AIWorks design work. Nothing here is built, enabled or deployed. It implements sections 3.2, 3.3 and 5.1 of [PROJECT_WORKSPACE_PLAN.md](../PROJECT_WORKSPACE_PLAN.md) under the owner's decision D3 (section 8 there). It builds on the merged [PROJECT_CONNECTION.md](PROJECT_CONNECTION.md) (#7) and [ADAPTIVE_SCHEDULER.md](ADAPTIVE_SCHEDULER.md) (#9). It proposes decision D4 (section 8) and does not enable it.

**Basis:** design notes; implementation status must be checked against the selected runtime revision.

Refs #8, Refs #14, Refs #5.

## 1. What the owner gets

- **Say what you want, once.** In a project, write a result in plain words, or pick a GitHub issue, a pull request or a plan file. AIWorks reads the project and shows a short plan: the outcome, how it will be checked, the main steps, what it may change, which AI providers it may use, and whether the result stops for your review.
- **Plan only, if you just want to look.** A plan-only request changes nothing and starts no work. You can turn it into real work later with one click, as long as the project has not changed in the meantime.
- **Approve once.** After you approve, AIWorks plans, splits, assigns, checks, repairs and retries on its own. It adds new steps when the work needs them. It does not ask you to approve each step.
- **It can't quietly do more than you approved.** A new step may never change files outside what you allowed, use a provider or permission you did not allow, publish somewhere else, release, raise your limits, or change what "done" means. If the work needs any of that, only the affected step stops, and you get one clear question.
- **Honest states.** For a GitHub project you see the real steps before work starts: plan file opened for review, checked, merged, started. For a project without GitHub you never see a fake pull request. Starting work there waits for two decisions that are not taken yet (D2 and D4), and the dashboard says so.
- **Nothing is merged, deployed or copied into your folder by this design.** Results stop at a verified pull request, or at a verified local candidate. Release is a separate, separately approved mode (#13).

## 2. Where things stand today (observed)

| Area | Current behaviour | Evidence |
| --- | --- | --- |
| Campaign | One JSON declaration, validated once. Its tasks (1 to 32) are fixed when it is registered. | `src/supervisor/campaign.mjs:1-3`, `:165-166`; `src/supervisor/api.mjs:23-25` |
| Immutable scope | `scopeDigest` covers everything except `authorization`, `limits`, `purpose` and task `outcome`. `authorityDigest` covers the whole declaration. | `src/supervisor/campaign.mjs:56-63` |
| Changing a campaign | A different scope is refused with `SCOPE_CONFLICT`. The executor may change only while paused with no open operation. A lower authorization version is refused. Any other edit needs `authorization.version + 1`, which replaces the stored declaration. | `src/supervisor/api.mjs:29-43`, `:80-81`; `docs/SUPERVISOR.md:108`, `:312` |
| GitHub assumptions | `authorization.reference` must be a GitHub URL, `target.repository` must be `owner/name`, and every campaign and task needs an issue number. | `src/supervisor/campaign.mjs:100`, `:109`, `:111`, `:178` |
| Registration | `cli.mjs start <file>` reads a declaration from any path. Only a **new** campaign is checked against the governance registry. Dashboard Resume restarts a paused campaign from its stored declaration. | `src/supervisor/cli.mjs:66-72`; `src/supervisor/campaign.mjs:230-236`; `src/dashboard/supervisor.mjs:326-328` |
| AW-005 | Decided: campaigns run only from merged code and a private approved declaration. **Not enforced in code yet**; the port of archived governance PR #139 is planned as `example-foundation/F1-AW005`. | `docs/DECISIONS.md:31-39`; `docs/STATUS.md:22` |
| Duplicate work (#5) | Not enforced in code yet; scope A (archived governance PR #126) is planned as `example-foundation/F2-DUPLICATE`. | `docs/STATUS.md:23`; `docs/design/ADAPTIVE_SCHEDULER.md:59-62` |
| Coordinator | Read-only by allowlist. It answers owner messages and may return a draft declaration as a **string** (`proposedCampaign`), which the supervisor posts to a GitHub issue as "draft, not registered". It reads only its own AIWorks checkout; other repositories only through `gh`. A changed checkout is a boundary violation. Its prompt asks for a run cap and a cost ceiling in drafts. | `src/supervisor/coordinator.mjs:1-4`, `:24-47`, `:56-70`, `:131-147`, `:196-200`, `:245-247`, `:360-366`, `:392-398` |
| Coordinator config | Needs 1 to 10 GitHub `owner/name` repositories and a GitHub `reportTo` issue. | `src/supervisor/coordinator.mjs:105-107` |
| Task specs | Every controller path reads a task's spec from the stored declaration (`decl.tasks.find`), including status. A task that is not in the declaration would break them. | `src/supervisor/controller.mjs:261`, `:522`, `:571`, `:629`, `:808`; `src/supervisor/api.mjs:129-130` |
| Packets | Built at dispatch from the declaration: goal, campaign + task constraints, task acceptance, revision-pinned references and governance values. `authorityDigest(decl)` is bound in. The packet digest is SHA-256 of the canonical packet. | `src/supervisor/controller.mjs:674-685`; `scripts/lib/worker-context.mjs:74-109` |
| Admission check | `planContext` is called with `authorityCurrent: true`, a constant. | `src/supervisor/controller.mjs:754-760`; `scripts/lib/worker-context.mjs:118` |
| Idempotency | Operation id `campaign.task.kind.seq` is also its `idempotency_key`, which is `UNIQUE`. | `src/supervisor/controller.mjs:632`, `:742-747`; `src/supervisor/store.mjs:38-44` |
| Fencing | Every controller write runs in `BEGIN IMMEDIATE` after `assertLease`. A lease is taken over only after expiry, with generation + 1. Dispatch re-reads the campaign version inside that transaction. | `src/supervisor/controller.mjs:141-150`, `:595-598`; `src/supervisor/store.mjs:132-146`, `:201-229` |
| Store growth | New tables are added with `CREATE TABLE IF NOT EXISTS`; the store version stays 1. | `src/supervisor/store.mjs:10`, `:19-77`, `:180-181` |
| Boundary violation | A worker that leaves its boundary is never retried on the same provider; the task waits for the owner (B3). | `src/supervisor/controller.mjs:380-382` |
| Reports | A verified report is posted as a marked comment on the task's issue. | `src/supervisor/controller.mjs:842-863` |
| Slots | One open operation per campaign. | `src/supervisor/controller.mjs:504`; `src/supervisor/campaign.mjs:118` |

**What this means:** today the owner hand-writes a complete, fixed task list, and nothing can add a task without a new campaign. The coordinator can draft, but its draft is free text that nobody validates. There is no place to store an approval, and no way to tell "the owner approved this exact plan" from "a file appeared".

## 3. Intake: from a request to a draft plan

### 3.1 The five routes

| Route | Available when | What is pinned | What the owner gives |
| --- | --- | --- | --- |
| **Describe a result** | Every project | Project base revision: GitHub base-branch SHA, or the local baseline (`project_baselines`, [PROJECT_CONNECTION.md §5.3](PROJECT_CONNECTION.md#53-the-baseline-it-binds)) | Up to 4000 characters of plain text |
| **Use an issue** | GitHub projects only | Base SHA, issue number and its `updated_at` | An issue of the project's own repository |
| **Continue a PR** | GitHub projects only | Base SHA, PR number, head ref and **head SHA** | A PR whose head branch is in the same repository. A PR from a fork is refused (`PR_FROM_FORK`): AIWorks never pushes to another repository. |
| **Use a plan or task file** | Every project | Base revision plus the file's path and blob SHA at that revision | A repository-relative path (`safePath`, `src/supervisor/campaign.mjs:43-44`). Secret-like paths are refused (`scripts/lib/worker-context.mjs:36-40`). |
| **Plan only** | Every project, combined with any route above | Same as the route | A switch. The result is a draft and nothing else. |

Issue, PR and plan-file text is **data, not instructions**, as the coordinator prompt already says (`src/supervisor/coordinator.mjs:200`). It can describe work. It cannot set the write scope, providers, limits, release mode or acceptance: those come only from the owner's Review screen (section 4.2).

### 3.2 How the coordinator drafts without registering (AW-004)

1. **Request.** The dashboard's *Start work* screen posts `{ projectId, route, text | reference, planOnly, requestId }` to a new owner route with the existing origin, CSRF and 16 KiB checks (`src/dashboard/server.mjs:60-69`, `:79-80`). The supervisor stores a `work_requests` row with an idempotent `requestId`, exactly as owner messages are stored (`src/supervisor/coordinator.mjs:161-182`). Nothing is dispatched.
2. **Evidence the code gathers, not the model.** Before the coordinator runs, deterministic code resolves and pins: the project and its governance values (`projectGovernance`, `src/supervisor/campaign.mjs:259-299`, or the D2 overlay); the base revision; the issue or PR metadata through the existing read-only reader (`src/supervisor/github-reader.mjs`); and the open campaigns of the same project with their tasks.
3. **Read-only checkout of the target.** The coordinator today reads only an AIWorks checkout (`src/supervisor/coordinator.mjs:131-147`). For intake it also gets a detached, read-only checkout of the target at the pinned revision: from the project's checkout for GitHub, from the managed mirror for local projects ([PROJECT_CONNECTION.md §5.2](PROJECT_CONNECTION.md#52-shape)). The existing "checkout still clean at that revision" rule applies to both checkouts (`:122-126`, `:360-366`). No `gh` command is offered for a local project, so it never fails because `gh` is missing.
4. **Structured draft, not a string.** An intake run uses its own output schema: `{ summary, plan, steps[], questions[], declaration }`, where `declaration` is a **declaration object** (section 4.1). The supervisor validates it with `validateDeclaration` and the envelope rules (section 4.3). An invalid draft is retried once with a fresh session, then shown as "AIWorks couldn't draft a plan" with the reason.
5. **Draft stored, never registered.** A valid draft is stored as a `work_drafts` row: request id, version, declaration, `scopeDigest`, `authorityDigest`, pinned revisions and `state = 'draft'`. Revising creates a new draft version. Nothing reads `work_drafts` when scheduling, so a draft cannot run.
6. **Conflicts are computed, not guessed.** Duplicate or overlapping work is found by code: scope A's `findWorkConflict` (planned, F2-DUPLICATE) and the scheduler's write-domain holders ([ADAPTIVE_SCHEDULER.md §4.3](ADAPTIVE_SCHEDULER.md#43-write-domains-and-work-ownership)). The coordinator's text may explain a conflict; it never decides one.
7. **Not posted to GitHub.** Drafts are shown only in the local dashboard. The coordinator's existing GitHub reply path for owner messages (`src/supervisor/coordinator.mjs:392-398`) is unchanged and is not used for intake.
8. **Stale drafts.** A draft is stale when its pinned base SHA, baseline, issue `updated_at`, PR head SHA or plan-file blob changed. A stale draft cannot be approved; the owner gets *Plan again*.
9. **Limits.** The current prompt asks the coordinator for a run cap and a cost ceiling (`src/supervisor/coordinator.mjs:198`). Intake drafts leave `limits` out: no limit is the default ([AW-002](../DECISIONS.md#aw-002---campaigns-have-no-capacity-limits-by-default)). Limits appear only when the owner sets them on the Review screen.

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
| `envelope.deliverables` | `commit`, `report` or both | Today's two kinds (`src/supervisor/campaign.mjs:176`) |
| `envelope.issues` | GitHub issues steps may report to | GitHub only; may be empty |
| `envelope.web` | Pages and origins a browser step may open | Today's `web` rules (`src/supervisor/campaign.mjs:197-210`), or `null` |
| `executor` | Providers, models and permission modes (unchanged block) | Today's rules (`src/supervisor/campaign.mjs:129-158`). This is "providers and roles": the role a provider may take is already fixed by deliverable and `web` (`src/supervisor/controller.mjs:572-583`). |
| `limits` | Optional owner limits (unchanged block) | Omitted means no limit (AW-002) |
| `envelope.release.mode` | `review-only` | The only accepted value until D5-gate and #13. `auto-release` is refused with `RELEASE_MODE_UNAVAILABLE`. |
| `envelope.planning` | `adaptive` lets AIWorks add steps; `fixed` keeps today's fixed list | |
| `envelope.scopeVersion`, `envelope.supersedes` | 1 for a new outcome; N + 1 for a wider scope that replaces campaign `supersedes.campaignId` | Section 6.7 |
| `envelope.request` | Route, reference and pinned revisions | From the draft; the owner cannot edit it |

**Relaxed for version 2:**

- `target.trackingIssue` and task `issue` are optional. Without an issue, only `commit` deliverables are allowed on a GitHub project, because a report needs a place to be posted (`src/supervisor/controller.mjs:842-863`). A local project never has issues; its reports go to the local evidence ledger (slice E10).
- `authorization.reference` is the request's issue or PR URL. For a goal without an issue it is an explicitly authorized request reference; a future local-reference contract remains a design proposal. For a local project it is `aiworks-local:<approvalId>` (section 8), accepted only while local admission is on.
- A local target replaces `repository`, `baseBranch` and `trackingIssue` with `{ source: "local-git" | "folder", baseline: { seq, commit } }`, and `projectId` must be the project's D2 overlay id (`lp-…`).

**Every initial commit task must declare `writes` within `envelope.writes`.** The same admission check as for children applies (section 6.3), so the owner-approved plan and later steps obey one rule.

### 4.2 What the owner sees on Review

The Review screen follows the plan's short preview ([PROJECT_WORKSPACE_PLAN.md §3.2](../PROJECT_WORKSPACE_PLAN.md#32-work-request---one-authorization-autonomous-execution-inside-its-scope-owner-approved-d3)): outcome and checks; main steps and how each is reviewed; conflicts with other work; what may change (`writes`, `denyWrites`), which providers, optional limits and release mode; then **Approve work** or **Revise**. JSON is under details only. Screen layout and copy belong to the owner-workspace design (#11); this design supplies the fields and the state copy (section 7).

The owner may narrow `writes`, add `denyWrites`, remove providers, set limits and edit wording. Editing creates a new draft version and a new digest. The owner may not hand-edit `request`.

### 4.3 Validation

`validateDeclaration` (`src/supervisor/campaign.mjs:84-222`) gains a version 2 branch. It keeps every version 1 rule and adds:

- `envelope` keys are exactly those in 4.1; unknown keys are refused, as today (`:89-90`);
- every initial task passes `validateTask` (today's per-task rules, extracted unchanged from `:168-212`) and the child admission rules of section 6.3, with the envelope as the boundary;
- a task id may not be `ACCEPT` or `PLAN` (reserved, section 6).

### 4.4 Digests

No new digest function. `scopeDigest` and `authorityDigest` (`src/supervisor/campaign.mjs:60-63`) already cover the new block:

- **Envelope digest** = `scopeDigest(declaration)`. It covers `envelope`, `target`, `executor`, `constraints` and the initial tasks, and is stored as `campaigns.scope_digest` (`src/supervisor/store.mjs:21-27`). Because the existing rules refuse a changed scope (`src/supervisor/api.mjs:29-33`), the envelope cannot change for a registered campaign.
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

- The declaration, its `scopeDigest` and its `authorityDigest` **never change** when a child is added. `campaignStart` with the same file stays idempotent (`src/supervisor/api.mjs:80-81`), and `SCOPE_CONFLICT` keeps protecting the envelope (`:29-33`).
- Children live in two new, additive tables. They are bound to the envelope digest by a hash chain, admitted only by deterministic code, and checked again before every dispatch.
- Declared tasks stay as approved. An amendment can **add** children and **revise or cancel children that have not started**. It cannot revise or cancel a declared task, and it cannot touch `ACCEPT` (6.6).

### 6.2 Where proposals come from

A proposal is the structured output of a **planning step**. That is an operation of kind `plan` on the reserved task `PLAN`, run by deterministic code under the campaign lease like any other operation. It uses a fresh session, read-only access and a validated packet. It reuses the packet contract unchanged: role `implementer`, access `read-only`, stage `plan`, which is allowed today for report work (`src/supervisor/controller.mjs:665-666`; `scripts/lib/worker-context.mjs:85-86`).

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

Admission is one pure function, `admitAmendment({ envelope, specs, holders, ops, basis })`. It runs inside the same fenced transaction that settles the planning operation (`src/supervisor/controller.mjs:292-310` today). Either the operation finishes **and** the amendment is admitted with its task rows, or neither happens. A refusal names the first failing check and the operation index.

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
| A11 | **Constraints:** a child's constraints add to the campaign's, within today's limit of 24 together (`src/supervisor/campaign.mjs:188`), counting the one constraint the envelope adds (6.5). | `INVALID_TASK` | replan |
| A12 | **Duplicate work (#5):** the child's fingerprint and optional `workKey` are not owned by another active campaign (`findWorkConflict`, F2) and do not repeat a live child of this campaign. Overlap with a write domain held elsewhere is not refused; the scheduler waits for it. | `DUPLICATE_WORK` | that op is dropped; the rest continue |
| A13 | **Injected content:** every text field is within its length limit, contains no control characters, and passes the coordinator's credential check (`containsSecret`, `src/supervisor/coordinator.mjs:80-85`). | `UNSAFE_TEXT` | replan |

**Refusal handling:**

- *replan*: the amendment is not admitted, the journal records `amendment-refused` with the code, and the next planning step gets the refusal as a constraint. After 4 refusals in a row with no task finished in between (the existing `NO_PROGRESS_LIMIT`, `src/supervisor/controller.mjs:30`), the campaign raises B3 *stalled*.
- *owner*: a widening is never retried and never admitted in part. The supervisor raises one B3 owner decision (OWNER_INTERVENTION.md) with the exact widening, such as "wants to change `src/billing/`", and two actions: *Approve wider scope* (section 6.7) or *Keep current scope*. Other in-scope work keeps running. Only the steps that would depend on the refused child wait.

**What no check can prove:** whether a child's *goal text* stays faithful to the outcome. That is bounded three ways instead. A child can only change files inside `writes`. Every child packet carries the approved outcome as a constraint (6.5). And the changed paths of each commit are checked after the run: a path outside the child's `writes` is a boundary violation (B3, `src/supervisor/controller.mjs:380-382`; the changed-path check is the scheduler's S3). The closing check `ACCEPT` and its independent verifier judge the outcome against the original acceptance.

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

- **Append-only.** Rows in `plan_amendments` are only inserted. A revision of a child is a new `task_specs` row with `revision + 1`. A cancel sets `cancelled_at` on the live revision and moves the `tasks` row to a new state, `cancelled`, which is not runnable (`src/supervisor/controller.mjs:40`). Nothing is deleted.
- **Hash chain.** `digest = sha256(canonicalJson({ campaignId, seq, parent: parent_digest, scopeDigest, authorizationVersion, sourceOperation, sourcePacketDigest, ops }))`. The `parent_digest` of seq 1 is the envelope digest. The plan head is the latest digest, or the envelope digest when there is no amendment.
- **Idempotency key** = `sha256(campaignId, sourceOperation, canonicalJson(ops))`, unique. An operation is settled once (`src/supervisor/store.mjs:40`). After a crash its result is read again from `result.json` and settled with the same key. A different planning operation proposing the same child is stopped by A3 (same id) or A12 (same fingerprint).
- **Crash windows.** Crash before the settling transaction commits: the operation is still open, and reconcile settles it later with the same key. Crash after: the operation is finished and nothing is applied twice. Slice E3 tests both with the controller's fault injection (`src/supervisor/controller.mjs:100-104`) at new points `after-plan-settle` and `before-plan-settle`.
- **Fencing.** Admission runs in `fenced(ctx)`. A controller whose lease generation is stale gets `FencedError` and writes nothing (`src/supervisor/store.mjs:224-229`). `lease_generation` and `code_revision` are recorded for audit.
- **Retries reuse ownership and revision.** A child's attempts, repair rounds, worktree, branch `campaign/<id>/<task>` and base SHA are the existing per-task rows (`src/supervisor/store.mjs:31-37`; `src/supervisor/adapters/git.mjs:25-39`). Retrying a child after a crash reuses them. It never re-admits the child.
- **One accessor.** `specOf(store, campaignId, taskId)` returns the declared spec or the live child revision. It replaces each `decl.tasks.find` in the controller and in status (section 2). `ACCEPT` and `PLAN` are generated from the envelope by the same accessor.

### 6.5 Packet digests for children

- **Declared tasks:** the packet is unchanged, including `authorityDigest = authorityDigest(decl)` (`src/supervisor/controller.mjs:677`). Running campaigns keep their packet digests.
- **Children:** `authorityDigest = sha256(canonicalJson({ authority: authorityDigest(decl), amendment: <digest of the amendment that set this spec revision> }))`. This is still a 64-hex value, so the packet schema and `acceptsLease` do not change (`scripts/lib/worker-context.mjs:14-15`, `:162-168`). A revised child gets a new digest, which forces a fresh session (`docs/WORKER_CONTEXT_LIFECYCLE.md:47`).
- **Packet content:** goal, acceptance and references come from the child spec. Constraints are the campaign's, then one envelope constraint ("Approved outcome: …. Change only: …; anything else is a boundary violation."), then the child's own, then verifier findings, as today (`src/supervisor/controller.mjs:680`).
- **Checked again before every dispatch.** Inside the fenced dispatch transaction, before the operation is recorded, the controller (1) recomputes the chain from the rows, (2) re-runs A3 to A11 for the live spec against the envelope, and (3) for a local project, re-verifies the approval and ledger (section 8). Any failure raises B2 `plan-integrity` and dispatches nothing. The result becomes the real `authorityCurrent` input to `planContext`, replacing the constant `true` (`src/supervisor/controller.mjs:755`).

### 6.6 The closing check and parent ownership

Every envelope gets a generated task `ACCEPT`: a read-only `report` whose acceptance is `envelope.acceptance`, verbatim. Its `dependsOn` is every other non-cancelled task, computed when it is scheduled. It maps each acceptance item to evidence: verified SHAs, PRs, reports and local candidates. It lists anything not covered. Its own independent verifier checks that mapping. This is #5 scope C ("accepting one PR must not close the parent") inside the Task Controller that already owns the campaign. It is not a new agent.

If items remain uncovered, a planning step runs (6.2). If two closing checks in a row report the same uncovered items with no task finished in between, the campaign raises B3: "This can't be finished within what you approved: {items}." The campaign is *ready* only when `ACCEPT` passes. Its report goes to `trackingIssue` when there is one. Otherwise it goes to the dashboard (GitHub without an issue) or to the local evidence ledger.

### 6.7 How it meets the immutable `scopeDigest` and #5 work ownership

- **Immutable scope stays immutable.** A wider scope is a new envelope: `scopeVersion + 1` and `supersedes: { campaignId, scopeDigest }`. It goes through the same approval and main gate (or D4). When it registers, the old campaign is cancelled through the existing cancel path once it has no open operation (`src/supervisor/api.mjs:232-234`). Its done tasks become dependency evidence of the new one. Its published but unmerged PRs keep their write domains until merged or closed ([ADAPTIVE_SCHEDULER.md §4.3](ADAPTIVE_SCHEDULER.md#43-write-domains-and-work-ownership)).
- **Executor amendments** may still change `scope_digest` (`src/supervisor/api.mjs:41-46`). Children stay valid only if the new declaration differs from the old one in `executor` alone, using the same test as `api.mjs:30-31`. The journal records `plan-rebound` with both digests.
- **Work ownership.** F2's `findWorkConflict` reads declarations. Slice E3 extends it to read live `task_specs` too, so a child is visible to other campaigns' registration exactly like a declared task. The scheduler's `domainHolders` reads children through `specOf`. A child's `writes` is its write domain, as the scheduler design already expects ([ADAPTIVE_SCHEDULER.md:139](ADAPTIVE_SCHEDULER.md#43-write-domains-and-work-ownership)).

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
| `READY_TO_START` | Ready to start (until Q2) | The plan file is merged. Start the work to let AIWorks begin. | Start work |
| `STARTING` | Starting | Merged at {sha7}. AIWorks is starting the work. | — |
| `START_REFUSED` | Couldn't start | AIWorks didn't start this work: {reason}. | {action from reason} |
| `GITHUB_UNKNOWN` | Can't check GitHub | GitHub can't be reached, so AIWorks doesn't know the state of pull request #{n}. It will check again. | Check again |
| `LOCAL_START_OFF` | Not available yet | You can plan work here. Starting work on projects without GitHub waits for two approvals (D2 and D4). | — |
| `LOCAL_SIGNATURE_NEEDED` | Waiting for your signature | Sign this plan with your AIWorks key to start it. | Show how to sign |
| `LOCAL_SIGNATURE_INVALID` | Signature doesn't match | This signature isn't valid for this plan, so nothing started. | Sign again |

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

### 8.1 The problem

AW-005 requires merged executable code and an explicitly authorized private declaration. Projects without GitHub still need a separate governed project-identity contract before local execution is supported. Any additional signed local-approval mechanism below is a design proposal; it is not a new gate on current CLI registration.

### 8.2 Threat model

- AIWorks, its workers and the owner's own tools run under the **same Windows account**. Anything that account can write, a misbehaving worker could in principle write, including the supervisor store (`supervisor.db`). Claude's deny rules are not an operating-system boundary (governance Constitution §9).
- So a hash chain in the store alone is **not** tamper-evident against that account: a full rewrite can recompute it. The approval must rest on something no process can use without the owner present, and on a trust root that is itself reviewed.
- Executable code is the other risk AW-005 answered: unmerged controller code must never admit new execution ([AW-005](../DECISIONS.md#aw-005---runtime-code-must-be-merged-declarations-remain-private)). D4 must not reopen that.

### 8.3 Proposed decision text

> **AW-005 amendment (proposed, D4) - Local projects may start a campaign from an owner-signed local approval**
>
> Status: proposed in `docs/design/WORK_ENVELOPE.md` for #8; takes the next free AW number when the owner accepts it.
>
> All campaign declarations remain private. Merged, reviewed executable code and explicit owner authority stay required for every project.
>
> In addition, a campaign whose target is a connected **local project** (Local Git or plain folder, D1) may use an optional owner-signed **private approval** when all of the following hold. The supervisor checks each one at registration, at resume and before every dispatch, and fails closed:
>
> 1. **Merged, reviewed, pinned code.** The supervisor runs from a revision that is an ancestor of `example-org/aiworks` `origin/main`, deployed by the documented upgrade procedure. Any change to `src/supervisor` had independent approval of its exact head. Nothing in a local approval or declaration is executed as code. It is data validated by that merged code under the same private declaration and scope rules as other campaigns.
> 2. **Private installation trust root.** If this optional approval design is accepted, permitted signing keys and revocations are installation data. They are not committed to the public source repository. Adding this stronger admission gate requires explicit operator authority.
> 3. **Owner signature with presence.** The owner signs the canonical approval record (8.4) with one of those keys. The signature is made in a way that needs the owner's physical action, such as touching a security key or typing a passphrase. The private key is never given to the supervisor, the dashboard, the coordinator or any worker.
> 4. **Governed project.** The target has an admissible D2 local overlay entry, and the approval binds that entry's digest. A project with a GitHub remote can never use this path.
> 5. **Append-only ledger.** The approval, every child amendment of that campaign and every revocation are appended to a local hash-chained ledger. Each entry binds the previous entry's hash. A break, a missing entry or a signature that no longer verifies stops new dispatches for the affected campaigns (B2) until the owner signs again.
> 6. **Same limits as every campaign.** Child tasks follow the same envelope admission. The supervisor still never merges, deploys or writes the owner's folder ([AW-001](../DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception)). A local result is a verified local candidate. Applying it is separately governed (#13).
> 7. **Revocation.** Removing the key from main, revoking or expiring the project's overlay entry, or the owner's *Revoke* action stops new dispatches at the next check. Running operations finish and are recorded, as with a pause.
>
> This amendment changes where an owner approval may come from, for local projects only. It does not let unmerged code run, and it does not change the GitHub main path.

### 8.4 The evidence that makes an approval tamper-evident

| Evidence | What it binds | What it defeats |
| --- | --- | --- |
| **Approval record** `aiworks-envelope-approval@1`: `{ approvalId (UUID), campaignId, projectId (lp-…), overlayDigest, declarationDigest = authorityDigest(declaration), codeRevision, approvedAt, startBy (≤ 30 days), nonce }`, as `canonicalJson` | The exact plan, project, rules and code revision at approval | A different plan, project or rules set reusing the approval |
| **Signature** over the record, OpenSSH `SSHSIG` with namespace `aiworks-envelope`, verified by `ssh-keygen -Y verify` against the trust-root file | That the owner, holding the key, approved this record | A worker or agent writing an approval: it cannot sign without the owner's key and presence |
| **Trust-root file** on `example-org/aiworks` main, read from the merged runtime revision (the `allowed_signers` format) | Which keys count | A key planted in the data directory |
| **Ledger** table `local_ledger(seq, kind, campaign_id, payload, payload_digest, signature, prev_hash, hash, created_at)`: `kind` is `approval`, `amendment` or `revocation`; `hash = sha256(prev_hash ‖ kind ‖ payload_digest ‖ signature)` | The order and completeness of approvals and amendments | Silently removing, reordering or adding entries, as far as the signed approvals reach. Unsigned amendments stay bounded by the signed envelope (section 6). |
| **Journal and status** | `local-approval-verified` with the record digest, key fingerprint and ledger head; status shows the key fingerprint and approval date | Unexplained state; it gives the owner something to check |

Why unsigned amendments are still safe: a forged amendment that passes section 6's checks adds only work the signed envelope already allows. One that does not pass is refused at admission **and** again before every dispatch. Widening a local envelope always needs a new signature.

The signing step for the owner (planned): the dashboard shows the approval record as a file and one command:

```text
ssh-keygen -Y sign -f <your AIWorks key> -n aiworks-envelope approval-<id>.json
```

The owner runs it in their own terminal and pastes or drops the `.sig` file. Which kind of key is owner question Q4. Whether `ssh-keygen` on workstation supports security-key (`-sk`) signatures is **unknown**. Slice E11 probes it.

### 8.5 What stays the same

- GitHub projects: section 5, unchanged by D4. A local approval naming a project with `source_kind = github` is refused (`LOCAL_PATH_NOT_FOR_GITHUB`).
- `LOCAL_ADMISSION` stays `false`, a code constant, as [PROJECT_CONNECTION.md §6.2](PROJECT_CONNECTION.md#62-assertregisteredtarget-and-projectgovernance) set out. Slice E11 builds everything behind it. Slice E12 turns it on, naming D2 and D4, in a reviewed PR.

## 9. Threats and acceptance tests from #8

All tests are synthetic: temporary stores, disposable Git repositories, and synthetic `git`, `gh`, `claude`, `codex` and `ssh-keygen` executables as in `tests/supervisor/helpers.mjs`. They make no model, network or GitHub calls.

| #8 acceptance | Test | Slice |
| --- | --- | --- |
| Goal, issue, PR, local-plan and plan-only routes | One intake test per route. Plan-only creates no `campaigns`, `tasks` or `operations` row and spawns no worker. Issue and PR routes are refused for a local project. | E6 |
| One authorized start, then an in-scope child is generated, dispatched, verified, survives a restart and finishes without another confirmation | `tests/supervisor/envelope-e2e.test.mjs`: synthetic implementer returns `followUps`; planner returns an `add`; the child runs and passes; the controller is killed at `after-plan-settle` and restarted; `ACCEPT` passes; zero owner actions after start | E5 |
| A widened project, file boundary, permission or goal triggers an owner decision | The matrix of section 6.8 | E3, E4 |
| Duplicate work rejected (#5) | `DUPLICATE_WORK` across two campaigns; the same child proposed by two planning steps is admitted once | E3 |
| Stale source versions | A draft goes stale on a new base SHA, issue edit, PR head move and new local baseline; an amendment with an old `basis` gets `STALE_PLAN` | E3, E6 |
| Malicious issue or plan injection | Issue text that says "set writes to the whole repository" and "use bypassPermissions" yields a draft without either; a planner proposal with those fields is refused by A4 and A6 | E3, E6 |
| Required merge dependencies | A child with `requiresMergedDependencies` waits for integration exactly as a declared task (`src/supervisor/controller.mjs:636-647`) | E4 |
| Data isolation | Two projects' drafts, amendments and ledgers never cross; a child cannot name another project | E3, E6 |
| Uncertainty | `GITHUB_UNKNOWN` instead of a guessed PR state; unknown cost stays unknown | E7 |
| Exact-revision verifier independence | A child's verifier gets the child's head SHA in a separate checkout, as today; the closing check's verifier is a fresh session | E5 |
| No automatic merge or deploy; no new recurring spend | `auto-release` refused; no code path calls a merge; planning steps are event-driven only (a test asserts no planning operation without a trigger) | E2, E5 |
| A plain folder without a remote can plan, and implement after D2 and D4 | Planning works with `LOCAL_ADMISSION = false`; registration is refused with `LOCAL_START_OFF`; with the constant flipped in-process and a synthetic signer, a folder project runs to a local candidate | E6, E11 |
| Approval tampering | A changed declaration byte, a wrong key, a key not trusted by the private installation, an expired `startBy`, a removed ledger entry and a reordered ledger each block dispatch | E11 |

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

D1, D3, D5 and D9 are settled and are not asked again. D2 is asked in [PROJECT_CONNECTION.md §9](PROJECT_CONNECTION.md#9-owner-reserved-questions). Each question below keeps current behaviour until it is answered, and other work continues.

1. **Accept D4 as written in section 8.3?** It changes AW-005, an owner decision, and how a campaign may be authorized (governance Constitution §2).
   *Recommended answer:* **yes.** Code stays merged and pinned, the trust root is reviewed on main, and the GitHub path is unchanged.
   *Default until answered:* projects without GitHub can be planned but not started (`LOCAL_START_OFF`).
   *Unblocks:* slice E12, together with D2 and Q4.
2. **Does approving a plan in the local dashboard count as your explicit registration of that exact plan?** For GitHub projects, AIWorks would then start the work by itself once the plan file is merged and matches your approval. AW-001 and AW-005 speak of campaigns "the owner explicitly registered", so what counts as that act is yours to decide.
   *Recommended answer:* **yes**, with the approval bound to the plan's digest. The dashboard is local-only with origin and CSRF checks ([AW-003](../DECISIONS.md#aw-003---the-operations-dashboard-is-local-only)). Answer it together with PROJECT_CONNECTION question 2, which asks the same about a project's rules.
   *Default until answered:* after the merge, the dashboard shows *Ready to start* and the owner's `cli.mjs start` registers the campaign, as today.
   *Unblocks:* slice E8, a true one-approval start.
3. **May campaign declarations be published through AIWorks branches or pull requests?** No. AW-009 keeps them private. The initial approval and any authorized amendments use private installation storage.
   *Recommended answer:* **yes, narrowly**: only a private local declaration with the exact approved bytes; never a declaration branch or public pull request.
   *Default until answered:* the dashboard shows the file (`DECLARATION_TO_OPEN`), and the owner's session opens the PR, as today.
   *Unblocks:* slice E9.
4. **Which key signs local approvals?** It is the owner's own credential.
   *Options:* (a) a FIDO2 security key (`ed25519-sk`), where each signature needs a touch; (b) a passphrase-protected SSH key kept out of `ssh-agent`, where each signature needs the passphrase.
   *Recommended answer:* **(a)** if you have a security key, otherwise **(b)**. Either way the public key goes to main by one reviewed PR.
   *Default until answered:* local admission stays off.
   *Unblocks:* slice E12. E11 builds and tests both kinds with synthetic keys.

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
| **E8** | The owner approves once in the dashboard and sees each real step | `src/dashboard/work.mjs` (new); `src/dashboard/server.mjs` (routes with origin, CSRF, 16 KiB); `src/dashboard/public/*` (Start work and Review areas only); `docs/OPERATIONS_DASHBOARD.md` | `tests/dashboard/work.test.mjs`: route security; exact copy for every code of section 7; no fabricated PR state; keyboard and 320px checks per UX-001/UX-002 | Approve-to-start needs no CLI when Q2 is yes; *Ready to start* otherwise | E6, E7; the #11 design and its file owner | **Yes:** Q2 for automatic start (screens ship without it) |
| **E9** | Private declaration persistence and idempotent registration | Private approval store and local declaration loader | Restart preserves the approved digest and registers only once; no declaration branch, PR or upload is created | Campaign data never enters source Git | E7 | No publication authority |
| **E10** | Local projects get verified candidates, never a fake PR | `src/supervisor/local-candidates.mjs` (new ledger of verified revisions and reports); `src/supervisor/controller.mjs` (publish branch for local kinds) | `tests/supervisor/local-candidates.test.mjs`: a verified local task records `{ sha, verifier evidence, baseline }`; `pushVerified` and `gh` are never called; status shows *Ready for your review* | Inert until local admission is on | E4; PROJECT_CONNECTION S4, S5 | No (used after E12) |
| **E11** | D4 built and tested, switched off | `src/supervisor/local-admission.mjs` (new: record, `ssh-keygen -Y verify` adapter, ledger, revocation); trust-root reader | `tests/supervisor/local-admission.test.mjs` with a synthetic `ssh-keygen`: every tampering case of section 9; GitHub project refused; `LOCAL_ADMISSION` false refuses all; workstation `-sk` support probe documented as a manual runbook step | `LOCAL_ADMISSION` stays `false`; no installation trust key provisioned yet | E3, E7, E10; PROJECT_CONNECTION S7 | No to build; **yes** to use (D4) |
| **E12** | Start work on projects without GitHub | `src/supervisor/local-admission.mjs` (`LOCAL_ADMISSION = true`); private installation trust-root file; `docs/DECISIONS.md` (record the accepted D4); `docs/SUPERVISOR.md` | Full local end-to-end with a synthetic signer: plain folder → signed approval → child → verified candidate → restart → finish | A plain folder without a remote runs to a verified local candidate; GitHub projects unchanged | E11; PROJECT_CONNECTION S7, S8 | **Yes:** D4 (Q1), D2 (governance merge and PROJECT_CONNECTION Q1, Q2), Q4 |

Applying a local candidate to the owner's folder and any Auto Release belong to #13, not to these slices.
