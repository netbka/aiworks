# AIWorks delivery supervisor

Work-state authority: [example-org/aiworks#2](https://github.com/example-org/aiworks/issues/2). This runbook covers slice A: a durable store, one explicit campaign, controller lease and fencing, one bounded headless worker, an independent verifier, and restart recovery. Slices B (GitHub webhooks plus owner-notification recovery, [example-org/aiworks#1](https://github.com/example-org/aiworks/issues/1)), C (project release adapter) and D (install evidence and canary on an approved host) remain open.

The supervisor applies the portfolio [CONTINUATION.md](https://github.com/example-org/governance/blob/main/docs/CONTINUATION.md) contract and this repository's [WORKER_CONTEXT_LIFECYCLE.md](WORKER_CONTEXT_LIFECYCLE.md). It does not redefine them. It reuses the C0 helpers in `scripts/lib/worker-context.mjs` (`validatePacket`, `packetDigest`, `planContext`, `acceptsLease`) and keeps no second packet or lease model.

governance provider's governance files (project registry, policies, project-contract schema) are read from the governance checkout described in [section 6](#governance-checkout).

## 1. Boundary

- **No Actions or paid GitHub features, for every project.** Builds and tests run on the local computer. GitHub Actions is prohibited, including free and self-hosted runners. No Codespaces, paid runners, billable Packages or Git LFS storage/bandwidth, paid marketplace services, paid add-ons or GitHub plan upgrades. Do not upload packages or LFS objects, provision GitHub resources or change billing. AI usage is allowed in any billing mode, including subscriptions and metered APIs; this rule adds no AI spending restriction. Existing campaign authority, budgets and security controls still apply.
  - On a runtime containing this change, every implementation, verification, browser and planning prompt carries this rule. Claude's tool denials also cover workflow/run commands, Codespaces and LFS transfers. These denials and instructions are defence in depth, not a sandbox for arbitrary code or proof of a provider's billing settings.
  - Before a verified push, GitHub write (including comments and merges), or optional GitHub backup, the supervisor reads the destination's Actions permissions through REST. Only `enabled: false` permits publication. Enabled, malformed or unreadable policy leaves publication pending under the existing retry rules; local work and verification continue. There is no cached approval and no automatic change to repository settings. Local results do not need GitHub.
  - The repository administrator disables Actions once for each managed repository, including new ones, and cancels any unfinished workflow runs. GitHub documents [repository Actions permissions](https://docs.github.com/en/rest/actions/permissions); [commit skip instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs) do not cover all event types. Keep required checks and branch protection intact: never fabricate a passing check or bypass protection.
  - The GitHub adapter accepts writes only for pull requests, issue comments, issue updates and authorized merges. Workflow dispatch, Codespaces, package, billing and other resource writes are refused before any CLI call. The Actions setting does not reveal existing account charges, LFS hooks, GitHub Apps or marketplace subscriptions; this gate is not an account billing audit or an OS sandbox. A prepared or merged change is not a runtime upgrade.
  - Supervisor Git commands and worker environments set `GIT_LFS_SKIP_SMUDGE=1` and `GIT_LFS_SKIP_PUSH=1` to suppress automatic LFS downloads and uploads, using the [Git LFS environment controls](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc). Repository security hooks remain enabled. Unavailable LFS content remains a pointer; a check needing it must report that limitation instead of silently downloading it or claiming success.
- It runs only campaigns the owner explicitly registered. A campaign declaration names the authorization, target repository, tasks and DAG, limits and executor. It never claims unassigned backlog.
- **Merged runtime code, private declarations (AW-005).** Runtime HEAD must be an ancestor of the trusted main: `origin/main`, or with `selfHosting.trustedMain: "local"` the trusted tip of local main (main ledger, section 6, [Local operation](#local-operation-rehearsal-switch-on-and-switch-back)). This check uses git on PATH, cannot be disabled and never fetches or changes a ref. Missing or unmerged code stops new execution and coordinator dispatch; already-running operations finish and their results are recorded.
  - `start <file>` reads a private local JSON declaration. Registration still requires explicit owner authorization and a registered target. Scope and task authority remain immutable; amendments need a higher authorization version and retain the existing executor/routing handover rules.
  - Campaign files and installation evidence remain outside public commits. Publishing a declaration is not a prerequisite for registration, amendment or an identical resume.
  - Dashboard Resume takes only the existing stored declaration, with atomic version, scope and authorization checks. It refuses unmerged runtime code; it never accepts a replacement declaration from the browser.
- **Registered targets only.** `start` registers a new campaign only when its `target.repository` equals, ignoring case, the `repository.github` of an entry in `registry/projects/` of the governance checkout (section 6). Otherwise it refuses with "is not a registered project".
  - The gate matches the repository only. It does not compare `target.projectId` with the registry `id`.
  - It reads the registry of the governance checkout configured for the data directory, not the AIWorks code. A new project's registry entry must be merged to governance provider's main and pulled into the governance checkout before its first campaign can start.
  - Only a new registration is checked against the registry. A campaign already in the store resumes, or takes an amendment, without this registry check; the merged-declaration check above still applies. Dispatch has its own check (next item).
- **One owner per repair ([#5](https://github.com/example-org/aiworks/issues/5) scope A).** `start` refuses a new campaign when one of its commit tasks is work that another campaign in the same store already owns. It answers `WORK_ALREADY_ASSIGNED`, names the owning campaign and task, and stores nothing: no campaign, task, operation or journal row. No worker starts and no budget is used.
  - **Same work** means the same tenant and repository (case ignored), and either:
    - the same task fingerprint: issue number, goal and acceptance list. Surrounding spaces and acceptance order are ignored. IDs, title, `outcome`, `purpose` and references are not part of it;
    - or the same `workKey` (below).
  - **Not serialized:** tasks with a different goal or acceptance list under the same issue, tasks that read the same files, report tasks, and other repositories or tenants.
  - **Who owns it:** a campaign that is registered, paused or cancel-requested owns all its commit tasks, including tasks already published. A finished or cancelled campaign releases them once no operation is recorded or dispatched.
  - **Same campaign:** an identical `start`, a resume and an amendment with a higher `authorization.version` are never refused; only a new campaign ID is checked. Owner authorization rules are unchanged.
  - **Atomic:** the check and the insert run in one `BEGIN IMMEDIATE` transaction, so two concurrent registrations admit exactly one.
  - **Optional `workKey`.** A commit task may add `"workKey": "<key>"`: lowercase letters, digits and `. _ : -`, at most 96 characters. Two tasks with the same key are the same logical repair, even when worded differently or filed under different issues. A key is not a file lock or an issue lock. It is part of the scope digest, so it can be set only at first registration. A declaration without one keeps its `scopeDigest` and `authorityDigest`. Code older than this change refuses a declaration that carries one.
  - **Optional `writes` (write domain, #5 scope B).** A commit task may list the part of the repository it may change: path prefixes (`"src/dashboard/"`, `"docs/SUPERVISOR.md"`) and named exclusive resources (`"resource:port-4319"`). An entry covers itself and everything below it, never a sibling that only starts with the same letters (`docs/A.md` does not cover `docs/A.md.bak`). Without `writes` the task owns the whole repository. The worker and its verifier are told the planned files in the packet constraints. The list is a plan, not a stop ([AW-013](DECISIONS.md#aw-013---planned-files-are-a-plan-not-a-stop)): a commit may also change another file the outcome needs, and the implementer explains each one in its report. The verifier's packet lists the changed files outside the plan, and the verifier accepts or rejects each one. Only a secret-like path, or a path inside an envelope's `denyWrites`, is a **boundary violation**, held for the owner and never retried on another provider (paths compared case-folded; an integration repair is measured from the base it merged). Like `workKey` it is part of the scope digest, and a declaration without it keeps its digests. Who holds a domain is derived from existing rows (`domainHolders` in `src/supervisor/work-ownership.mjs`): an open implement operation (in any campaign, until it is settled), a task implemented, verifying or verified, and a published commit until it is in the base (in finished and cancelled campaigns too, except a cancelled campaign of the self-hosted repository with local main trusted: only the merge gate moves that main and it never merges a cancelled campaign, so its heads release their domains without counting as merged). Admission by domain belongs to the scheduler (section 7, built and off by default); while it is off, campaigns run as before.
  - **Optional model routing fields ([MODEL_ROUTING](design/MODEL_ROUTING.md), slices R3 and R5).** Without `routing`, every step runs on the declared executor order, as before. With `mode: "auto"`, each dispatch chooses among the declared candidates by the deterministic policy of MODEL_ROUTING (`src/supervisor/router.mjs` `routeAuto`) and stores the receipt with the run. The cohort, its comparison against a baseline and the rollback are the operator's ([section 6](#model-routing-cohort-switch-on-compare-and-switch-back-mod7), slice R7); none has happened.
    - A campaign may add `routing`: `mode: "auto"`, 1 to 16 `candidates` (`{ kind, model, tier }`, tier 1, 2 or 3), optional `sensitivePaths` (path prefixes) and an optional `pin` (`implementer` and/or `verifier`, each `{ kind, model }` or `{ tier }`). A candidate's `kind` must already be one of the declared executor providers, and a pin must name a declared candidate or tier. So routing can never add a provider, a model outside the list, or a permission.
    - A task may add `role`, a role id from governance provider's catalog `registry/agents.json`, read from the governance checkout and never copied. A new registration with a role that is not in the catalog is refused, and so is one with any role when the catalog is missing or malformed. A declaration without roles does not read the catalog.
    - A task may add `routing: { risk: "high" }` and/or `complexity: "high"`. A declaration can only raise a level, so `"high"` is the only value.
    - All of these are part of the scope digest, like `executor`; a declaration without them keeps its `scopeDigest` and `authorityDigest`. Changing `routing` follows the executor rule: a higher `authorization.version`, a paused campaign and no open operation (`ROUTING_HANDOVER_REQUIRED` otherwise), journalled as `routing-amended`. A task's `role` and `routing` are fixed at registration. Code older than this change refuses a declaration that carries any of them.
  - **Not covered yet:** duplicates registered before the registration check existed.
- **The target project's rules in every packet.** Before each new worker dispatch the controller resolves the target the same way, from the same governance checkout: the one registry entry whose `repository.github` equals `target.repository`, ignoring case. The packet then carries a `governance` block of values, never file contents:
  - `project`: the registry `id`;
  - `policies`: the IDs of the portfolio policies in `policies/catalog.json`, in catalog order. A policy conditioned only on the `ui` boundary is left out for a project whose contract lacks the `ui` capability; every other condition depends on the change, so the policy stays;
  - `authorities`: the project's declared `governance.authorities`, as role and repository-relative path;
  - `exceptions` and `gaps`: the declared entries as `id` and `rule` only.

  The prompt names the project and tells the worker to read those authorities in its own checkout of the target. It must not take project rules or files from any other project's repository; the listed portfolio policies are inherited and apply. No worker starts, and there is no default project, when:
  - no entry matches, or more than one does;
  - no governance checkout is configured, or it has no `registry/projects`;
  - the registry or catalog cannot be read;
  - the entry fails `schemas/project-contract.schema.json`. A field the schema leaves optional may be absent and counts as empty, but a malformed one (for example `authorities` that is not a list) is never read as empty.
  - an authority is secret-like: a `.env*`, `.git`, `.ssh` or `.gnupg` segment, an `id_rsa*`, `id_ed25519*`, `credential(s)` or `secret(s)` segment, or a key, certificate or keystore file. The registry schema refuses such a path in every pointer field, so a registry entry cannot declare one.

  The campaign instead gets a B2 `project-governance` blocker naming the repository and the reason, and a `recheck` evaluates it again.
  - Operations recorded before this change keep the packet, digest and prompt they were recorded with; the controller never rebuilds them. The field is optional in the packet schema, so those packets stay valid.
  - The packet digest binds the new field like every other. The lease binding (tenant, project, environment, task, stage, run, session, revision and `authorityDigest`) is unchanged, as are `scopeDigest` and `authorityDigest` of a declaration, so a resumed campaign matches its stored scope.
- **Owner wording (optional).** A declaration may add a campaign `purpose` and a per-task `outcome`, each a plain-language sentence of up to 300 characters saying what the work delivers and for whom. The [operations dashboard](OPERATIONS_DASHBOARD.md) shows them before IDs and slice titles.
  - They never enter a worker packet and are excluded from the immutable scope digest. Adding or changing them on a registered campaign therefore needs only a higher `authorization.version`, not a new campaign.
- **A reference may name one section ([SCOPED_READING §3](design/SCOPED_READING.md#3-the-reference-grammar), slice READ1).** **Anchors take effect on a runtime that includes READ2.** There, dispatch turns each anchor into a line of the worker's reading guide that names the section's lines (observed in code: READ2 is merged, [PR #165](https://github.com/example-org/aiworks/pull/165)). On an older runtime nothing gives an anchor a meaning: the worker is told to read the path, and the literal `#` makes that read fail. Merged is not deployed, so check that the running runtime includes READ2 before writing anchors into a private declaration.
  - **Grammar.** A task reference is a repository path (the whole document, as before) or `path#anchor` (one section of a Markdown document), for example `docs/SUPERVISOR.md#3-lifecycle-of-one-task`. The anchor is the slug GitHub renders for the heading: 1 to 160 of `a-z`, `0-9`, `_` and `-`, after exactly one `#`. Two sections of one document are two entries; each counts toward the 24.
  - **Refused.** A reference with two `#`, an empty anchor or another character in it is refused at `start`, and in a child amendment with `INVALID_TASK`. A path that itself holds a `#` can no longer be referenced. A secret-like path is refused with or without an anchor (`docs/.env#x`, `secrets.md#y`): in a version 2 declaration and in a child amendment as `WIDEN_CAPABILITY`, in a version 1 declaration when it carries an anchor.
  - **Digests.** The anchor is part of `scopeDigest`, like the rest of the reference. A declaration without anchors keeps its `scopeDigest` and `authorityDigest`. Code older than READ1 accepts an anchored reference without checking the anchor.
  - The resolver (`src/supervisor/reading.mjs`) finds a section's lines from its heading; nothing calls it yet.
- **Version 2: one approved envelope ([WORK_ENVELOPE §4](design/WORK_ENVELOPE.md#4-the-approval-envelope), slice E2).** A declaration may be `"version": 2` with an `envelope` block: the approved outcome and the boundary every task stays inside. Version 1 declarations are unchanged: `envelope` is still an unknown key there, and every committed declaration keeps its `scopeDigest` and `authorityDigest`. A version 2 declaration registers through the same `start`, with every version 1 rule and gate. Nothing adds tasks to it yet: child tasks are slice E3 (STA8).
  - **Fields.** `outcome` (1 to 300 characters); `acceptance` (1 to 16 checks); `writes` (0 to 32 path prefixes or `resource:<name>` entries, none secret-like; empty means report-only work); optional `denyWrites` (prefixes inside `writes`); `deliverables` (`commit`, `report` or both); `issues` (issue numbers, may be empty); `web` (today's `web` rules, or `null`); `release: { mode }`; `planning` (`adaptive` or `fixed`); `scopeVersion` (1, or N + 1 with `supersedes: { campaignId, scopeDigest }` of another campaign); `request: { route, reference, pinned }`. The route is `goal`, `issue`, `pr` or `plan-file`. `pinned.base` is a commit id. An issue also pins `issueUpdatedAt`, a PR `headSha`, a plan file `path` and `blob`. Unknown keys are refused.
  - **Review only.** `release.mode` accepts only `review-only`. `auto-release` is refused with `RELEASE_MODE_UNAVAILABLE`: a release mode belongs to a destination and comes only from a grant, never from a campaign (plan resolution C10, gap G6).
  - **The approved tasks stay inside the envelope**, with the refusal code in the message: a commit task must declare `writes`, each inside `envelope.writes` and not overlapping `denyWrites` in either direction (`WIDEN_FILES`; paths compared with `\` as `/`, no trailing `/`, case folded); its deliverable is in `deliverables`, its references are not secret-like and its `web` pages and resource origins are within `envelope.web` (`WIDEN_CAPABILITY`); its issue is in `issues` (`WIDEN_DESTINATION`). Campaign, task and the one envelope constraint fit in 24. The task ids `ACCEPT` and `PLAN` are reserved.
  - **Projects without GitHub ([AW-012](DECISIONS.md#aw-012---local-projects-start-from-an-owner-approval-in-the-dashboard), slice STA17).** Work starts on a connected Local Git project or plain folder when the owner has confirmed its rules in the dashboard and then approves a plan there. Merged is not deployed: this works on a runtime that includes STA17. The dashboard's *Approve and start* for local projects (slice UI17) is built in source and switched off by default ([OPERATIONS_DASHBOARD.md](OPERATIONS_DASHBOARD.md#a-project-without-github-plan-approve-review-and-apply-built-off-by-default)).
    - **The plan.** A version 2 declaration with `target: { tenantId, projectId, environment, source, baseline }`: `projectId` is the `lp-` id of the confirmed rules, `source` is `local-git` or `folder`, and `baseline` is `{ seq, commit }` of a baseline of AIWorks's copy. It has no `repository`, `baseBranch`, `trackingIssue`, task `issue`, `readSources`, `requiresMergedDependencies` or research-only executor; `envelope.issues` is empty and `envelope.planning` is `fixed` (steps added later are not written to the local ledger yet). `authorization.reference` is `aiworks-local:<approval id>`.
    - **Registration.** Only `registerLocalPlan` (`src/supervisor/local-admission.mjs`) registers it, in one transaction: the rules are confirmed and not revoked (`RULES_NONE`, `RULES_REVOKED`), the baseline is one AIWorks has (`BASELINE_UNKNOWN`), and the owner's approval admits exactly this plan once (expired rules, a changed plan, other rules, another code revision or a used approval are refused with their codes). `start` and program waves refuse a local plan with `LOCAL_APPROVAL_REQUIRED`.
    - **Running.** Before every dispatch the controller checks the rules and the approval again; a refusal is a B2 `local-admission` blocker and no new worker starts. Workers and verifiers run in worktrees of AIWorks's copy (the mirror for Local Git, the snapshot for a plain folder) from the plan's baseline; nothing is fetched. A verified task becomes a local candidate (*Ready for your review*); nothing is pushed or applied to the owner's folder. Reports, blockers and notes stay in this computer's store (outbox rows with state `local`); `gh` is never called for the project.
  - The envelope is part of `scopeDigest`, so a registered campaign's envelope cannot change (`SCOPE_CONFLICT`); a wider scope is a new campaign. Code older than this change refuses a version 2 declaration.
- In the target repository it may create worktrees and `campaign/<campaign>/<task>` branches, push a verified commit to that branch, open a PR, and post issue comments ([AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception)). It never deploys or releases. It never removes worktrees or deletes branches, except through cleanup after finished work (section 15, built, not enabled), which never touches a remote branch, a worktree with changes or run evidence. It merges only under the merge gate (section 3, "Merge gate"), in a repository the owner opted in; otherwise merge and release follow the project's own gate.
  - Git cannot hold both a `campaign/<campaign>` branch and `campaign/<campaign>/<task>` branches. A declaration branch named `campaign/<campaign>` in the target repository makes every dispatch fail with "cannot lock ref", so declaration branches are named `declare/<campaign>`.
  - **AIWorks's own repository with local main trusted** (`config.json` `selfHosting.trustedMain: "local"`, off by default; [LOCAL_OPERATION section 5.2](design/LOCAL_OPERATION.md#52-where-reports-and-notes-go), slice SELF7): publication pushes nothing and runs no `gh`. A verified commit becomes a `review` item in the local work list, linked to its campaign, task and verified SHA, with the local branch named in its body (not as a label, which a long legal campaign and task id would overflow); the task's result link is `aiworks-work:<n>`. A repaired head is a comment on that item, a report one whole comment on the task's item (up to 1 MiB, never split), and outbox notes and blockers are comments on the tracking item, whose number the owner notice links. Each is written in the transaction that marks the task done or the note posted, under a stable key, so a crash or retry records it once. Such a campaign may name its authorization `aiworks-work:<n>`: before every dispatch the item must be open, written by the owner and linked to this campaign, or a B2 `work-authorization` blocker holds new workers. Every other repository publishes exactly as above. For such a campaign, `trackingIssue` and `issue` are work-list numbers and reports go to the work list.
  - **The one-time issue import** (`work-list import [--apply]`, [LOCAL_OPERATION section 5.4](design/LOCAL_OPERATION.md#54-the-one-time-import-and-closing-on-github), slice SELF10) reads the open issues of `selfHosting.repository` and all their comments with REST `GET` only, page by page, and writes nothing without `--apply`. Pull requests are skipped, but the highest issue or pull request number is reserved, so a new item never takes a number GitHub used. An imported item keeps its number, source URL and the issue's `updated_at`; each comment keeps its author and time and is recorded once under its GitHub id. A re-run adds only new comments and lists changed titles and bodies without overwriting the item; a number held by another item is listed as a conflict. Secret-like text is withheld and listed by number and comment id, never printed. It never comments on or closes an issue.
  - **Closing the imported issues** (slice SELF11) is built but switched off: it is a GitHub write outside a campaign, so its only caller is the owner's typed confirmation in the dashboard (UI20, [OPERATIONS_DASHBOARD.md](OPERATIONS_DASHBOARD.md#the-local-work-list-ui20)), and no CLI command offers it. The amended [AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception) (SELF12) permits this one close after the owner's confirmation; the source switch `CLOSE_IMPORTED_ON` (`src/supervisor/work-list-import.mjs`) still ships `false`, so the dashboard answers that closing is not switched on until a change switches it on with its tests. The owner confirms a list of imported items; each entry binds the repository, the number, the issue's `updated_at` at import and the version of the stored item. The dashboard's caller check runs first, so a request from a worker or any other AIWorks process is refused, and a stale, foreign or changed entry refuses the whole list before anything is written or sent. For each issue in order, one changed on GitHub since the import is skipped and reported; otherwise the closure is recorded in the store, one marked pointer comment ("Moved to the AIWorks local work list as #n on <date>. Continue there.") is posted and the issue is closed as `not_planned`. Labels and issues outside the list are never touched. A retry after a crash finds the recorded closure and the marked comment and closes without commenting again; an issue changed after the pointer, or closed by someone else, is skipped.
- Workers use only the executor or ordered CLI chain authorized by their private declaration. Usage/rate limits and exhausted credits or billing limits move to the next eligible provider; when every eligible provider is waiting, the campaign waits for the earliest reset and continues. Each attempt is a fresh, separately recorded and charged operation; the runner contains its process tree before accepting output or trying another provider. Permission denials never cause fallback. The CLI controls and remaining platform limits are described in section 8.
- **Web acceptance tasks** run only on a browser worker, AGY (`agy-cli`) or Claude given the same isolated browser; AGY runs nothing else (section 11).
- Wiki's native workers are restricted to the brokered research mode described below; their terminal envelopes must bind the exact fresh run nonce and packet digest, and unknown usage/cost stays unknown.
- No GitHub Actions, no new paid service, no Telegram workflow of its own (owner notification belongs to the owner-intervention core, section 10, [example-org/aiworks#1](https://github.com/example-org/aiworks/issues/1)). Blockers and status are written to the store and posted on the campaign's tracking issue, or on its tracking item in the local work list; a project without GitHub has none, so its blockers and status stay in the store.

## 2. State and ownership

Before registering a task, inspect the callers, existing tests, fixtures and schema copies affected by its goal. Include necessary compatibility repairs in its `writes`; shared code may need a test directory rather than a guessed list of individual tests. A registered task cannot expand its own scope. If a required file was omitted, the operator checks the existing authority, preserves the work and findings, cancels and drains the old campaign, then registers a corrected replacement with the same acceptance. This is routine recovery when existing authority covers it; genuinely wider authority still needs the owner.

`cancel <campaignId> [reason]` also accepts a finished campaign. It stops later merge and integration/CI repair attempts while preserving its declaration, task outcomes, costs, commits and run evidence. A merge, integration or CI pass rechecks the campaign control inside the fenced transaction that would reopen a published task, so a cancellation committed after the pass selected the task still leaves that task and its operations unchanged. Use this to retire historical automation before redirecting a checkout to a replacement repository; never reinterpret old issue or PR numbers as objects in the new repository. Cancellation does not close remote PRs or remove their write-domain holds. In the self-hosted repository with local main trusted, a cancelled campaign's published heads hold nothing once it is cancelled (its open runs drained), because no path can merge them. Record the replacement mapping privately and start fresh work under its own declaration.

| Concern | Owner |
| --- | --- |
| Campaign scope, assignment, findings, published status | GitHub issues/PRs, or the local work list for AIWorks's own repository with local main trusted; the declaration file in `campaigns/` |
| Trusted main of AIWorks's own repository | the main ledger in `supervisor.db` (section 6, [Local operation](#local-operation-rehearsal-switch-on-and-switch-back)) |
| Controller lease, operations journal, checkpoints, retry timers | `supervisor.db` (SQLite, WAL, `synchronous=FULL`) in the data directory |
| Worker packet contract, admission, stale-run predicate | C0 helpers (`scripts/lib/worker-context.mjs`) |
| Project registry, portfolio policies, project-contract schema | governance provider, read from the governance checkout (section 6) |
| Project acceptance and release | the project's router, manifest and release gate |

Every controller write runs in `BEGIN IMMEDIATE` and first checks that this instance still holds the campaign lease generation (`assertLease`). Workspace preparation, runner launch, publication and outbox effects hold that same write lock, so lease expiry cannot admit a conflicting controller while an external command is in progress. Commands remain bounded by adapter timeouts; competing owner actions can temporarily receive SQLite's busy error. A lease is taken over only after it expires, with generation + 1. Owner actions (start, pause, cancel, recheck) use compare-and-swap on the row version.

## 3. Lifecycle of one task

1. **Implement.** The supervisor prepares the isolated worktree, builds and validates the packet, writes the run directory, then commits the operation record (idempotency key `<campaign>.<task>.<kind>.<seq>`, session UUID, packet and digest) and counts the run against `maxWorkerRuns`. Only after that commit does it launch a detached runner.
2. **Runner.** `runner.mjs` takes an exclusive `run.lock`, records process creation identity, heartbeats and enforces the time bound. On Windows it contains the worker and descendants in a non-breakaway Job Object. All members must stop before an atomic `result.json` can release the operation. Unsupported platforms fail closed. It never interprets model output.
3. **Result.** The controller classifies stdout. Possible classes: `result`, `invalid-result`, `exit-without-result`, `timeout`, `auth`, `quota`, `spawn-failed`, `error`, or `lost` (heartbeat stale). A normal exit or the word "done" is not a result.
   - A `result` is accepted only after process containment has settled, its local JSON schema validates, the process exits successfully, and the session matches the dispatched run (`acceptsLease`).
   - For a commit deliverable, the worktree head must equal `headSha` and be a clean, new descendant of the task base.
4. **Verify.** A different fresh session runs in a separate detached checkout of the exact target, read-only. Its result must echo the target SHA and the sha256 of the implementer report. Acceptance also requires the verifier checkout to remain clean at that SHA and rejects failed checks or blocking findings. Rejection with blocking findings becomes a bounded repair round, and the findings travel in the next packet's constraints.
5. **Publish.**
   - `commit` deliverable: push exactly the verified SHA and open one PR, looking up an existing PR first.
   - `report` deliverable: post the verified report to the task issue once, reconciled by an embedded marker.
   - Both: a note goes to the tracking issue through the outbox.
   - Every GitHub call uses the REST API through `gh api` and the owner's existing `gh` login, never GraphQL. GraphQL has its own hourly quota that other tools on the account (such as the dashboard) can use up ([#21](https://github.com/example-org/aiworks/issues/21)). The calls are:
     - find an open PR for the task branch: `GET repos/{repo}/pulls?head={owner}:{branch}&state=open`, before every create;
     - open the PR: `POST repos/{repo}/pulls`;
     - read a merge receipt (section 4): `GET repos/{repo}/pulls/{n}` (`merged`, `merge_commit_sha`, `head.sha`, `base.ref`);
     - find and post comments: `GET` and `POST repos/{repo}/issues/{n}/comments`.

Report terminal output is capped at 52,000 characters before verification and publication
preserves it exactly. When the report and its verification together exceed GitHub's 65,536-character
body limit, the verification is published as a separate marked supervisor comment (on the task issue
for a report, on the PR for a commit); each part is found by its marker before posting, so a retry
never posts twice. Nothing is truncated; a publication blocker is raised only if a part alone still
exceeds the limit.

Every PR title and body and every issue or PR comment passes one privacy check before it is sent
([#8](https://github.com/example-org/aiworks/issues/8), `src/shared/public-text.mjs`). It reuses the public-scope
rules (credential material, personal installation paths, the installation's private terms from
`.local/publication.json` in the runtime and target checkouts) and also refuses drive and UNC paths and paths under a POSIX or macOS filesystem root (`/opt`, `/tmp`, `/srv`,
`/etc`, `/var`, `/usr`, `/home`, `/Users`, `/Volumes` and similar); repository-relative paths, URLs and REST routes
such as `GET /repos/o/r/issues` pass. Naming the
upstream owner's other projects is refused only for the AIWorks repository itself. `publish` checks every part of a
publication (PR body, split verification comment, repair comment) before the push and before the first GitHub call,
and the GitHub adapter checks again at each call. A refusal names categories only, never the matched text:

- The verified report, its digest and the verification stay in the task row and the run evidence; the journal records
  `publication-refused` with the categories, sources and report digest. Nothing is redacted or truncated.
- A refused report reopens the task as a publication repair round (a `publication-text` finding): the implementer
  rewrites the report, keeping the same head when the code needs no change, and a fresh verifier checks it. A refused
  verification alone goes to a fresh verifier of the same head. At most two such rounds, within `maxRepairRounds`;
  then, or when the supervisor's own text is refused, the task stalls. No new owner decision is needed for wording.
- A refused outbox note is marked `refused` and never sent or retried; one note without its text says it was withheld.

Completion guidance names the actual target and
deliverable. SQLite uses FULL synchronization; atomic file writes fsync their contents,
but Windows rename metadata persistence under power loss remains unverified. Missing
process ownership proof fails closed; these tests do not establish power-loss durability.

When every task is published, the campaign becomes `ready` with control `finished`, and the next action is the project's release gate.

### Integration repair of a published PR

A sibling PR can merge first and leave a published PR in conflict with its base ([#27](https://github.com/example-org/aiworks/issues/27)). With integration repair on, the supervisor repairs it itself, through the same verification as any other change.

- **Off by default.** With no `integrationRepair` block in the data directory's `config.json`, nothing below happens and a published PR stays as it is. Turn it on with `"integrationRepair": { "enabled": true }`. Like any runtime change, that goes through the upgrade procedure (section 6).
- **Detection is local.** At most once per `integrationPollMs` (one minute) per campaign, for each published, unmerged commit task, the supervisor fetches the base branch (30-second bound), lists the campaign's remote branches with `git ls-remote`, and runs `git merge-tree --write-tree <base> <verified SHA>` (Git 2.38 or newer). It makes no GitHub call. Finished campaigns are checked too, until every published head is in the base or its branch has moved; after a restart each is checked once more.
- **Left alone:** a task whose verified head is already in the base, whose remote branch no longer points at the verified head (merged and deleted, or pushed by someone else), or that merges cleanly.
- **On a conflict** the task reopens as a repair round, and a finished campaign becomes active again. The journal records `integration-conflict` with the conflicting paths and the sibling commits on the base that touched them. The repair packet carries them as a blocking finding: merge that base into the same branch, resolve, run the gate, commit. It counts against `maxRepairRounds`; past the bound the task stalls instead.
- **Checks on the repair.** The implementer's new head must contain both the earlier verified head and the base it was reopened for, or the result is refused. A worktree that lost the verified head gets no further worker until it is reconciled. A fresh verifier then checks the exact new head; the prompt asks it to review the resolution with `git show --remerge-diff` and run the full gate.
- **Publication.** The supervisor looks up the task's open PR first. If there is none, it pushes nothing and opens no PR; the task stalls (`integration-repair-unpublished`). Otherwise it pushes the verified head to the same branch as a plain fast-forward, never a force-push: if someone else moved the branch, the push fails and is retried. It posts the fresh verification as a marked comment on that PR and records `integration-repaired`. The PR body is not rewritten.
- **Known limits.** A squash-merged PR whose base later changes the same lines can look like a conflict while its branch still exists. A PR closed without merging is noticed only at publication, after the repair runs. Ownership through integration across campaigns stays with #5 scope B.

### CI repair of a published PR

Verification runs on this computer (Windows). The optional CI repair reader predates the policy prohibiting Actions in every managed repository. It can still read existing check results and send a failure back for local repair ([#42](https://github.com/example-org/aiworks/issues/42)); it never dispatches or reruns a workflow, authorizes paid CI, or requires Actions to be enabled. A missing online check is not fabricated as a pass.

- **Off by default.** With no `ciRepair` block in the data directory's `config.json`, the supervisor never reads CI and a published PR stays as it is. Turn it on with `"ciRepair": { "enabled": true }`. Like any runtime change, that goes through the upgrade procedure (section 6). Status shows CI as `unknown` while it is off.
- **Reading CI.** After publication, the supervisor reads the PR head's check runs through REST: `GET repos/{repo}/commits/{sha}/check-runs` (one page of 100). It reads each published commit task at most once per `ciPollMs` (one minute), only until CI completes, then stops. Finished campaigns are read too. After a restart a head whose CI is not settled yet is read once more. A rate-limit refusal waits for the reported reset.
- **What counts.** CI has passed only when every check run completed as success, neutral or skipped. It has failed when every run completed and one failed, timed out or could not start. Any other completed result (for example cancelled) is `inconclusive`. A head with no check run 30 minutes (`ciNoChecksMs`) after publication is recorded as having no CI. Neither counts as a pass. The journal records `ci-pending` once, then one of `ci-passed`, `ci-failed`, `ci-inconclusive` or `ci-none`, with the check names.
- **On a failure** the supervisor first checks that the task's PR is still open at that head. If it is not (merged, closed, or pushed by someone else), it records `ci-failed` with `repair: false` and does nothing else. Otherwise the task reopens as a repair round and a finished campaign becomes active again. The repair packet carries the failing check names, conclusions and links as a blocking finding: fix the cause on this branch, guard platform-specific behaviour, never weaken or skip a test, run the gate, commit. It counts against `maxRepairRounds`; past the bound the task stalls instead. The tracking issue gets a note.
- **Checks on the repair** are those of the integration repair. The new head must contain the earlier verified head. A fresh verifier checks the exact new head.
- **Publication** is that of the integration repair: the same branch and PR, a plain fast-forward push, never a force-push, never a new PR. It posts the fresh verification as a marked comment and records `ci-repaired`. Then CI of the new head is read in turn.
- **Status.** `status` carries `ci` per task (`state`, `sha`, `checkedAt`, `checks`) for every published commit task, and a campaign-level `ci`. It reads only the journal, never GitHub. The state is `unknown` (never read), `pending`, `success`, `failure`, `inconclusive` or `none`. The campaign-level `ci` is `success` only when every published head passed, and `failure` when any failed. A published step is never shown as passed while its CI is red or unknown. With CI repair on, the publication note on the tracking issue says CI is not known yet.
- **Known limits.** The repair packet names the failing checks, not the failing tests inside them; the worker reads the check output. A head with more than 100 check runs is `inconclusive`. Showing `ci` on the dashboard belongs to lane UI.

### Changes the owner requested on a finished result

On a finished step's review the owner may request changes ([OPERATIONS_DASHBOARD.md](OPERATIONS_DASHBOARD.md#review-of-a-result-owner-ui-v2-wp4), owner UI v2 WP4). It needs no setting and adds no authority: the request is recorded once per verified head as a `result-changes` event, bound to the goal's authorization version and scope digest, the step's version, the verified head and its report digest.

- **Reopening.** The next pass handles the request inside the campaign's fence, in a finished campaign too. Only while the step is still done at exactly that head, unmerged, a commit step, and the authorization and scope are unchanged, it reopens the step as a repair round on its own branch and PR, exactly like a CI repair: an `owner-changes` blocking finding carries the owner's words to the builder, the verified head is the round's base, a finished campaign becomes active again, and it counts against `maxRepairRounds` (past the bound the step stalls instead). The journal records `result-changes-reopened`; a request that no longer applies records `result-changes-stale` and changes nothing. A paused campaign keeps the request until it resumes.
- **Merge gate.** While a request for a head waits, that head is not a merge candidate, and a merge already selected checks again inside its fence before the call.
- **Checks and publication** are those of the CI repair: the new head must contain the earlier verified head, a fresh verifier checks the exact new head and is told the owner's request as data, and only then is it pushed to the same PR as a fast-forward with a marked comment. The comment says that changes were requested, never what they were. The journal records `owner-changes-repaired`.
- **Accept** records the owner's acceptance of a verified head (`result-accepted`) and nothing else: merging stays with the merge gate below, or with the project's own gate.

### Merge gate

Merging used to be delegated to a monitoring session (`merges.delegatedTo: "monitor"`). When none ran, verified PRs waited for hours ([#138](https://github.com/example-org/aiworks/issues/138)). With the merge gate on, the supervisor merges a verified PR itself, and only when merging it puts exactly the independently verified tree on the base branch. It still never deploys, releases or changes provider resources ([AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception)). The gate is `src/supervisor/merge.mjs`; its one merge call is `src/supervisor/release/github-merge.mjs`, since merge calls live only under `release/` (REL5).

- **Off by default.** Only the owner's `config.json` turns it on, per repository. Without `merges`, with `"delegatedTo": "monitor"` (or anyone other than `"supervisor"`), or for a repository not listed, nothing is merged. A malformed setting also leaves it off and is logged. The setting is the one the dashboard already reads; `held` works for both:

  ```json
  "merges": {
    "delegatedTo": "supervisor",
    "decision": "#138",
    "repositories": ["example-org/sampleapp"],
    "held": { "https://github.com/example-org/sampleapp/pull/12": "owner-review" }
  }
  ```

  Keep `decision`: without it the dashboard does not treat merging as delegated and lists verified PRs in **Needs you**. Like any runtime change, turning it on goes through the upgrade procedure (section 6).
- **The gate.** Every condition must hold. Each repository is checked at most once per `integrationPollMs` (one minute), after a fresh fetch of its base:
  1. the repository is listed and the PR is not in `merges.held`;
  2. the PR is the one this campaign task opened, on its `campaign/<campaign>/<task>` branch, still open, against the declared base branch, and its head is the task's verified SHA;
  3. the verified SHA contains the current `origin/<base>`, so the merge result is the verified tree;
  4. with `ciRepair` on, CI at the verified head passed, or the repository runs no CI on it. A head whose CI is unread, pending, inconclusive or failed waits; a failed one is reopened by CI repair first. With `ciRepair` off the gate does not read CI, so turn it on with the merge gate;
  5. GitHub reports it mergeable;
  6. the campaign is neither paused nor cancelled, and this supervisor code passes the AW-005 merged-code check;
  7. the owner has not requested changes to that head (section 3, "Changes the owner requested on a finished result");
  8. where the project's acceptance mode is "owner" ("I accept results myself" in Project settings, [AW-015](DECISIONS.md#aw-015---acceptance-controls-merging-when-the-owner-chooses-it)), the owner accepted exactly that verified head with the report it was checked with (`result-accepted`). An acceptance of an earlier head, or of the same head with another report, does not count. The mode is read from the newest project settings at every check, so it holds after a restart: switching to "owner" holds every unmerged head without acceptance, and switching back to "automatic" (the default, also for every project that never set it) lets the gate continue as before. It applies to every merge path: one at a time, the refresh, the group merge (AW-014) and the local merges of AIWorks's own repository. A held head is not a refresh or group candidate, and the condition is checked again in the fenced write that records `merge-requested` and, for a local merge, again before main moves (`src/supervisor/result-review.mjs` `awaitingAcceptance`).

  A PR that fails a condition waits. The journal records `merge-waiting` with the reason each time the reason changes.
- **When the base has moved** (condition 3 fails), the supervisor does not merge. It reopens the task as an integration repair round on the same branch and PR (section 3, "Integration repair of a published PR"), even with `integrationRepair` off. The journal records `merge-base-moved`. The round merges the base in, a fresh independent verifier checks the exact new head, and the repaired head is pushed to the same PR. Only then can the PR merge. This also catches a semantic conflict that merges cleanly as text. It counts against `maxRepairRounds`.
- **Refresh (opt-in, `merges.refresh`; owner decision 2026-10-17, off until set).** Most moved bases never touch the PR: on 16-17 Oct, 19 of 23 `merge-base-moved` rounds shared no file with the base, and each cost a fresh implementer, a fresh verifier and two full gates. With `"refresh": { "command": ["npm", "ci", "&&", "npm", "run", "check"], "timeoutMinutes": 120 }` the supervisor first checks that the base and the PR changed no file in common (case-folded) and merge without a conflict. It then builds the merge result with `git merge-tree`, commits it locally only (never pushed), checks it out in a detached worktree under the repository's worktree root, and runs the command there through the gate helper as a separate process. While that gate runs, the repository's merges wait, so the next PR is judged against the base this one leaves. When the gate passes, conditions 4 to 6 apply as usual and the PR merges at its unchanged verified head: GitHub's merge commit then carries exactly the tree the gate ran. A shared file, a conflict, a failed gate, a gate past `timeoutMinutes`, or a git failure falls back to the integration repair above, and its finding says why. The journal records `merge-refresh-started` (worktree, commit, command), then `merge-refresh-passed` or `merge-refresh-failed`, so a restart continues the same refresh. A gate that ended without an exit code starts again in the same worktree; the supervisor never kills a gate, and one past `timeoutMinutes` fails the refresh. A pass counts only while the worktree is still at the recorded merge commit and tree. Code: `src/supervisor/merge-refresh.mjs`.
- **Group merge (opt-in, `merges.batch: true`, needs `merges.refresh`; [AW-014](DECISIONS.md#aw-014---waiting-pull-requests-merge-as-one-group-after-one-gate-run)).** When two or more verified PRs wait for the same base, the supervisor merges them as one group instead of one at a time. It merges each head in turn onto the previous result with `git merge-tree` (a PR that conflicts stays out), commits the chain locally only, and runs the refresh command once on the combined result in a detached worktree. When that gate passes, every PR is read again; if one can no longer merge, none merges as part of the group. Then the PRs merge on GitHub in chain order, each only while the base is exactly the previous step of the checked chain, and each merge commit (also one settled after a restart) must carry the tree that step predicted. GitHub gets 15 minutes to report mergeability before the group stops. A failed or stuck gate, a base that moved, or a PR that can no longer merge ends the group (`merge-batch-failed` or `merge-batch-stopped`), and the rest go one at a time as above; the same group on the same base is never gated twice. The journal rows (no campaign) are `merge-batch-started`, `-passed`, `-failed`, `-stopped` and `-done`; a restart continues the same group, and a merge requested before a crash is settled by reading the PR first.
- **The merge.** `PUT repos/{repo}/pulls/{n}/merge` with `merge_method=merge` and `sha=<verified SHA>`, so GitHub refuses if the head moved. Never a squash, a rebase, a force-push, an admin bypass or a branch deletion. At most one PR per repository per pass; the next is judged against the refreshed base.
- **Crash safety.** The journal records `merge-requested` before the call, then `merged` with the merge commit, or `merge-refused` with GitHub's answer. Every attempt starts by reading the PR (`GET repos/{repo}/pulls/{n}`): a PR already merged at the verified head is recorded as `merged` (`reconciled: true`) without a second call. A recorded merge is never read or attempted again, after a restart too. The tracking issue gets a note that says merged is not deployed.
- **Local form (built, not enabled; [LOCAL_OPERATION section 4.4](design/LOCAL_OPERATION.md#44-the-local-merge-gate), slice SELF8).** For AIWorks's own repository with local main trusted (`selfHosting.trustedMain: "local"`) and listed in `merges.repositories`, the candidate is a verified local review (`aiworks-work:<n>`, which `held` also takes), and no remote is read and no `gh` runs. Instead of conditions 2 to 5: the review item is the one recorded for the task, the local branch `campaign/<campaign>/<task>` is at the verified SHA, the base branch is `main`, the verified SHA contains the trusted tip of the main ledger, local `main` is exactly that tip (otherwise it waits: "main has N commits AIWorks did not put there"), and the checkout that has `main` checked out, if any, has no changes or untracked files (otherwise it waits: "your checkout has unsaved changes"). A trusted tip the verified SHA does not contain sends the task back as an integration repair round, as above; `merges.refresh` does not apply. The merge (`src/supervisor/release/local-merge.mjs`): the journal records `merge-requested` with the trusted tip, then a merge commit is written with the verified tree, the trusted tip as first parent and the verified SHA as second; a commit whose tree is not the verified tree is `merge-refused` and nothing moves. Under the campaign's lease, with the campaign checked again for pause or cancellation, `main` moves from the trusted tip to that commit only: a fast-forward in the clean checkout, or a ref update that names the trusted tip as its old value. The `gate-merge` ledger row and the `merged` journal entry commit in that same transaction. After a crash, `main` is read first: if it is the planned commit (same parents, verified tree) it is recorded once with `reconciled: true`; if it is still the trusted tip the merge is tried again; anything else waits. It stays off until SELF13 sets `trustedMain` through the upgrade procedure.
- **Backup of trusted main (built, not enabled; [LOCAL_OPERATION section 4.6](design/LOCAL_OPERATION.md#46-github-as-an-optional-backup), slice SELF9).** With the local form on and `selfHosting.backup.enabled`, the merge pass, after its local merges, pushes the trusted tip of the main ledger, never local `main` itself or a commit after the tip, to `selfHosting.backup.remote` as `refs/heads/<branch>` (`src/supervisor/github-backup.mjs`): never a force, a `+` refspec, a mirror or tags, bounded to 60 seconds, and at most one attempt every 10 minutes, counted from the `backup-requested` journal entry written before the push, so a restart does not shorten it. The outcome is journaled in the campaign of the newest local merge as `backup-pushed`, `backup-refused` (the remote rejected the update; Git's reason, redacted) or `backup-failed` (unreachable, including a local backup folder that does not exist, timed out or could not run). A refused tip is not pushed again; the next recorded merge's tip is, and status names no next attempt for it. A failed one is tried again after the interval. Nothing waits on the backup: the next local merge is judged exactly as without it. `status` of a campaign of that repository shows `selfHosting`: the trusted tip, local `main`, the number and first 50 unrecorded commits, and `backup` (`off`, `none`, `pushing`, `pushed`, `refused` or `failed`, with the tip, reason and time, the newest tip the remote accepted, whether it is the trusted tip, and when the next attempt may run). It stays off until SELF13.
- **Known limits.** A PR merged by someone else is left alone and not journaled as merged by the supervisor. The dashboard still shows a merge when the verified commit reaches the base branch.

## 4. Liveness and failure semantics

Idle ticks read local files and SQLite; no model is called for polling. Tasks explicitly declaring `requiresMergedDependencies: true` also refresh read-only Git base refs at a bounded one-minute interval after dependency publication. Direct ancestry or an exact reviewed-head GitHub merge receipt (including squash/rebase) must be present in the freshly fetched base before admission. Failed reads retain the wait. Independent eligible tasks continue; this wait never merges anything (merging is the separate, opt-in merge gate in section 3). Every nonterminal campaign has one of: an open operation, a durable `next_wakeup_at`, an owner pause, or an explicit blocker. A campaign with none is recorded as `liveness-defect`.

| Event | Handling |
| --- | --- |
| Controller dies after the checkpoint, before launch | The replacement launches the same recorded operation. `run.lock` guarantees at most one runner. |
| Spawn was attempted but no ownership receipt exists | A durable launch marker prevents a duplicate. After the startup grace period the campaign records an explicit process-ownership blocker; an operator must reconcile the unknown process outcome. A missing receipt never proves that no process exists. |
| Controller dies while a worker runs | The replacement adopts the run through its heartbeat and consumes the result. No second dispatch. |
| Host reboot (runner and agent lost) | The runner's Job Object closes with it and stops descendants. Recovery checks the exact process creation identity and job before a fresh session can retry within budget. Legacy runs without ownership evidence remain blocked for operator reconciliation. |
| Exit without a result, invalid result, timeout, error | Bounded retries with backoff (`maxRetriesPerTask`). The task then stalls as `blocked-child` until `recheck`. |
| Authentication failure | A single-provider campaign records B2. An explicitly authorized CLI chain marks that provider unavailable and tries the next eligible provider. The wait is untimed: a failed login does not heal by itself, and every re-dispatch would consume a counted run. A campaign `recheck` after the owner restores the login ends it. When no eligible provider remains, the campaign raises the B2 `executors` blocker. A chain also records the failed login on the provider account (next row): other campaigns on that account wait silently, without a second owner question, and the one `recheck` resumes them all. A single-provider campaign's failed login stays its own B2 blocker. |
| Provider usage limit | The wait belongs to the provider **account**, not the campaign: a usage limit, a failed login found by a chain, or this PC's own sandbox failure holds every campaign on this PC that uses the account (`provider_waits`, `src/supervisor/accounts.mjs`). A finding about one project or task (for example project CLI extensions) and a failed launch stay with that campaign. The account is the executor kind unless `config.json` names it (`"providerAccounts": { "claude-cli": "claude-main" }`, a name only, never a credential). A success on the account or a `recheck` of any campaign using it ends the wait once: every campaign using the account drops its own copy of the wait, its waiting tasks are due at once, and its journal records `provider-wait-cleared`. During the upgrade a wait recorded per campaign before it is still honoured: the later of the two applies. A single-provider campaign waits account-wide; a chain waits that provider out and selects the first eligible alternative. Reset evidence (epoch, ISO timestamp, Retry-After, or a zoned wall-clock reset such as `resets 1:50pm (Asia/Jerusalem)`) is recorded with a one-minute margin. Unknown reset times wait 30 minutes. If all providers wait, persist the earliest reset. State survives restart and the original provider becomes eligible again after reset. Claude's measured zero-work refusals retain the existing refund rule; Codex/Cursor's unknown dollar cost is never treated as zero. A campaign `recheck` ends the waits. No model calls for polling. The wait is silent. Under the provider-limit exception in [OWNER_INTERVENTION.md](https://github.com/example-org/governance/blob/main/docs/OWNER_INTERVENTION.md#rate-limits--quotas) ([AW-002](DECISIONS.md#aw-002---campaigns-have-no-capacity-limits-by-default), no capacity limits by default), an owner-accepted subscription usage limit is a B4 external wait with no owner notification, whatever the reset time. A paid upgrade remains B3. |
| GitHub refuses a publication call | A rate-limit refusal (403 or 429 with `Retry-After`, or `X-RateLimit-Remaining: 0` with `X-RateLimit-Reset`) records its reset time. The task stays `verified` and publishes once at that reset plus `rateLimitMarginMs` (5 seconds); a reset more than an hour away counts as an hour. The journal records `publish-rate-limited`. A refusal without a reset time, and any other failure, retries after `publishRetryMs` (5 minutes). The lookup before every create keeps a retry from opening a second PR. The comment lookup and the outbox keep their fixed retries. |
| Missing CLI or failed launch | A chain records the provider and reason, tries the next provider, and rechecks after 15 minutes for an unconfigured command (no run is consumed). A failed launch waits untimed until a campaign `recheck`, like an authentication failure. Installation/authentication is never inferred from a declared fallback. |
| Permission denial or invalid/rejected result | Keep the existing bounded repair/blocker path. Never switch providers to route around a denial or failed verification. |
| Executor unavailable (Codex sandbox helper cannot start any process, Cursor sandbox unsupported) | Class `unavailable`: the run is refunded (no task attempt took place), the provider enters a 20-minute timed wait for host failures (untimed for configuration findings), and the task goes to the next eligible provider. A Codex worker whose every `command_execution` failed with `Failed to create unified exec process` is classified this way even when it returned a valid `evidence-unavailable` envelope; a worker whose commands ran keeps its own verdict. Before each Codex dispatch the controller runs a token-free `codex sandbox` echo probe (`config.codexSandboxProbe: false` disables it in synthetic tests). |
| Failed attempt on a chain | The next eligible provider gets the retry first; the provider that failed remains the fallback when it is the only one eligible. Denials and verifier rejections are not rerouted; only the choice among already authorized providers changes. When the retry stays on the provider that failed, `status` gives the reason in owner words under the task's `routing.sameProvider`, for example "Claude again: the last review timed out, and Codex may not take this step on this computer" (on Windows, Codex neither implements nor reviews a commit task). |
| Report repair | The repair packet carries the blocking findings as constraints and the prompt carries the rejected report inside `<rejected-report>`, with a report-only instruction (produce a corrected complete report; no commit). Commit deliverables keep the commit-and-return-headSha instruction. |
| Worker returns `blocked-owner-reserved` | B3 on that task only. Independent tasks continue. Only `recheck --task <id>` or a dashboard answer to that decision clears it. The result may carry an optional, schema-validated `decision` (question, options with consequences, suggestion, what continues, what happens unanswered); a checker that still rejects after the repair rounds may carry one too. A dashboard answer is a `decision-answer` event bound to that one stop ([OPERATIONS_DASHBOARD.md](OPERATIONS_DASHBOARD.md#decisions-owner-ui-v2-wp2)): the controller clears it only while the task still holds that same stop, resolves its blocker record and queues the answer once as guidance for the next builder run. It never clears the campaign blocker or another task. |
| No progress | A task whose fresh sessions return `evidence-unavailable` four times (at least ~42 minutes apart, given the backoff) stops with a B3 owner decision naming the last reason, whatever the retry limit. The same applies to a failure that repeats identically (aiworks#136). Suppose four fresh sessions in a row end in the same non-provider failure class (`error`, `invalid-result`, `exit-without-result`, `timeout`, `spawn-failed` or `lost`) with the same detail. The task then stops with one B3 owner decision named `no progress: 4 identical <class> failures; last: <detail>`, and it is not retried again. A different class or detail, or an `evidence-unavailable` result, starts that count again. A run refunded because no task attempt took place leaves the count unchanged. Provider waits and provider limits (`quota`, `auth`, `unavailable`) keep their own handling. These are no-progress guards, not spend caps: worker-run limits stay the owner's choice. A resolved or accepted result resets both counts; `recheck --task <id>` clears the block and the counts. Workers must report authorization-scope or owner-decision blockers as `blocked-owner-reserved`, which stops at once. |
| Worker-run cap or cost ceiling reached | B3 budget decision. **By default a campaign has no budget limits.** Every key in `limits` is optional, and an omitted or `null` limit means no limit; the whole `limits` object may be left out. `slots` defaults to 1; it may be declared 1..8 or `"auto"`, which takes effect only when the scheduler (section 7) is enabled. It is off by default, so every campaign runs one operation at a time. With no limits, the only stop is the providers' own subscription or usage limits, which the campaign waits out. A failing task keeps retrying with the 2/10/30-minute backoff, and a rejected deliverable keeps getting repair rounds. A budget exists only when the owner declares one: `maxWorkerRuns` (1..100), `maxRepairRounds` (0..5), `maxRetriesPerTask` (0..5) and `maxCostUsd` bind when set. An amendment that raises or removes a limit releases the stalls that only that limit caused (`stall-released`); owner-reserved and admission stalls are never released this way. An optional `limits.maxCostUsd` adds a dollar ceiling: measured provider cost plus `limits.unknownRunCostUsd` (required with the ceiling, never zero) for every counted run whose provider reported no cost. `status.budget` shows the charged total. A project's standing budget (dashboard Project settings, WP5; `project-settings.mjs`) binds every campaign of the project on top of its own limits: admission (`admissionBudget`) starts no paid run while less than one run at the project's declared unknown-run price fits, all time or this UTC month, and raises the same B3 budget blocker, which clears by itself when the budget allows. Planning counts against the same budget: every coordinator run that drafts a work request is charged to the request's project (through the `work_requests` row that records it), and a message read to the one project its messages name; retries are separate runs and each counts. An open planning run is reserved at the unknown-run price, a finished one without a reported cost is charged at that price, and a failed planning run keeps the cost its worker reported. Only durable proof that no paid worker started refunds a run: a planning run whose runner failed before attaching its job (`spawn-failed` with `notStarted`), and a run blocked at admission, refused by the provider before any work, or whose executor was unavailable. A containment failure after the worker attached, a timeout, a lost run and every cancelled worker run (`abandoned`, whether its stop status is `stopped` or `not-running`: `not-running` also follows a worker that launched and then exited or crashed without a result) are each charged once, at their reported cost or the unknown-run price, so they never free room for an uncovered retry. The coordinator checks the budget in the fenced transaction that records a planning run, so the recorded run is the reservation: a restart resumes that run rather than starting another, and a campaign admitted at the same time sees it. A message or request the budget cannot cover stays received with the reason `project-budget` (dashboard: Waiting for budget; journal `planning-budget-wait`), does not hold up other projects, and is read by itself once the owner raises or removes the budget or the month that ran out ends. A message read that names no project or several is charged to no project: Project settings shows it apart as planning that names no single project. A project without a budget is unchanged. Its protected areas refuse a registration or a higher authorization version whose writes lie inside one (`PROTECTED_AREA`) and hold a commit that changes one as a boundary violation; neither rewrites a registered declaration. A start with `authorization.version + 1` and higher limits resumes without losing work. The amendment also recounts runs from the stored operations: every recorded run counts except an admission-blocked one, a refusal that did no work, and an unavailable executor. The recount is idempotent, so a count corrected earlier is never reduced twice. The journal records `runs-recounted` when the number changes. |
| Crash between push and PR, or after a report post | The lookup before create/post reconciles. There is no exactly-once promise. |
| A published PR conflicts with its base after a sibling merge | With `integrationRepair` on, a verified integration repair round on the same branch and PR (section 3, "Integration repair of a published PR"). Off, the PR stays as it is. |
| A merge call's outcome is unknown (crash, lost response) | The next pass reads the PR first. Merged at the verified head: recorded as `merged`, with no second call. Still open at it: the gate is judged again (section 3, "Merge gate"). |
| A published PR's CI fails | With `ciRepair` on, a verified CI repair round on the same branch and PR (section 3, "CI repair of a published PR"). Off, the PR stays as it is and status shows its CI as `unknown`. |

## 5. Commands

An ordered executor may be declared as `cli-chain` with `providers` in priority order:
`codex-cli`, `claude-cli` (model and permission mode required), then `cursor-cli`; `agy-cli`
(model required) may be added as a fourth provider for web acceptance tasks (section 11).
Each native command must be configured in local `config.json`; Windows uses the native
executable rather than a `.cmd` shim. Changing executors requires a paused, drained
campaign and a higher authorization version. Target, tasks and acceptance remain immutable.
The amendment preserves operations, results and spent runs. `status` and the dashboard
show the selected executor and durable `executorWaits`; `recheck` clears those waits.
The dashboard uses `commands.gh` from the selected data directory, so a newly installed
or hidden login process does not depend on an interactive shell's GitHub CLI PATH.
An explicit owner-authorized `limits.maxWorkerRuns: null` removes the run cap while
retaining accounting, one slot, per-run timeouts and bounded task retries. Omission or
invalid values are rejected; existing numeric caps continue to apply unchanged.

The `sample-wiki-planning` declaration assigns only a planning report for Wiki #91.
The separate `sample-wiki-execution` declaration records the owner's subsequent request for continuous execution of that independently verified plan. It assigns P1–P9, preserves A/B/C/I reservations and uses uncapped runs with bounded per-task retries and independent verification. The prior planning campaign remains complete. Implementation progresses automatically through eligible tasks and provider recovery; publication is not integration or native acceptance. Native/materialization, isolated Target and promotion evidence remain required gates. The supervisor does not mutate sample-native, merge (outside the owner's opt-in merge gate, section 3), deploy or revive deferred human work/provider execution. A blocked release task keeps this execution parent open rather than reporting planning completion.

Planning campaign isolation:
All its providers set `researchOnly: true`: the controller captures declared checkout
references, open issues/PRs, recent PR metadata and recent coordination comments using
read-only GitHub APIs, plus explicitly authorized `authorization.readSources` paths at
pinned external revisions. Secret paths and escaping symlinks are refused. Capture is
bounded at 320KB; issue/comment truncation and omitted history are explicitly labelled.
Required missing evidence remains unknown and can block acceptance. Workers receive
that snapshot in empty scratch directories; Codex shell/hooks/plugins/apps/skill MCP installation/web search and
Claude built-in tools and inherited MCP are disabled. Cursor uses ask mode, sandbox and explicit read/write/shell
denials; an unavailable sandbox fails closed. Project/global extension configurations
without an adapter policy are refused.
Codex account-linked apps are explicitly disabled even when user configuration is ignored;
an unexpected native research tool invocation rejects the result without provider fallback.
The installed Codex build still exposes a patch tool through its code-mode host; the
read-only sandbox remains required, and any reported file-change/tool event rejects
the report except the explicitly supplied `aiworks_repository.read` capability. This existing
GET-only broker is fixed to the campaign's target repository and allows complete issue
bodies and paginated coordination comments without restoring account-linked apps.
Claude safe mode also suppresses explicitly supplied MCP servers in the installed
build; its fallback uses the controller snapshot only and must report missing details
as evidence blockers. Safe mode is not weakened to enable additional tools.
Local Git status and recent commit metadata are captured by the trusted controller.
Failed broker reads reject the result without provider fallback. Disabling feature flags
is not evidence that every built-in tool is absent.
A research task's snapshot holds only its declared `references`. If the target
repository's own rules send its worker to more authorities, list every one of them in
`references`. Otherwise the worker cannot read a rule it must follow, and the run cannot
finish ([#150](https://github.com/example-org/aiworks/issues/150)).
This does not authorize implementation in Wiki,
mutation of SampleApp, merges or deployment. Cursor is a declared fallback, not proof of a
working Cursor installation on this host.

Run these from the runtime checkout, `C:/example/aiworks/.local/runtime` on workstation. `start` reads a private local declaration, kept in the ignored `campaigns/` or `.local/campaigns/` folder or outside the checkout, and refuses runtime code that is not merged into the trusted main with `RUNTIME_NOT_MERGED` (section 1).

```sh
node src/supervisor/cli.mjs start campaigns/<campaign>.json --data C:/example/aiworks/.local/supervisor
node src/supervisor/cli.mjs status <campaign> --data C:/example/aiworks/.local/supervisor
node src/supervisor/cli.mjs pause <campaign> "reason" --data C:/example/aiworks/.local/supervisor
node src/supervisor/cli.mjs cancel <campaign> "reason" --data C:/example/aiworks/.local/supervisor
node src/supervisor/cli.mjs recheck <campaign> --task <task> "note" --data C:/example/aiworks/.local/supervisor
node src/supervisor/cli.mjs stop --data C:/example/aiworks/.local/supervisor
node src/supervisor/cli.mjs trusted-main --data C:/example/aiworks/.local/supervisor
```

`trusted-main` (read-only, never fetches) prints the trusted tip of local main on its first line and the number of unrecorded commits after it on the second; it is refused with `TRUSTED_MAIN_NOT_LOCAL` while `origin/main` is the trusted main, and with `NO_ANCHOR` or `MAIN_REWRITTEN` when the ledger gives no tip. `trusted-main anchor` is the one write: the switch-on step records local `main` as the ledger's anchor, once, and only when it equals `refs/remotes/origin/main` as last fetched (`ANCHOR_REFUSED` otherwise). It does not fetch.

`start` reads `governanceRoot` from the data directory's `config.json`, or takes `--governance <path>` (section 6).

`status` first says whether the supervisor is running at all (`supervisor`, section 6), then reports readiness:
- `ACTIVE` only while a live controller holds the lease;
- `BOOTSTRAP_REQUIRED` before the first controller lease; `CONTROLLER_OFFLINE` after lease expiry;
- `PAUSED`, `CANCELLING`, `CANCELLED` or `COMPLETE` otherwise.


### Read-only diagnosis

Use the installed task's data directory, not an old example or the shell's current directory.
On workstation the task uses `C:/example/aiworks/.local/supervisor`.
Inspect `(Get-ScheduledTask -TaskName 'AIWorks Supervisor').Actions` before assuming a location.
Use the absolute CLI path and absolute `--data` path from a separate shell; alternatively set
`AIWORKS_DATA` to that same directory. An explicit `--data .` is also valid.

`status` opens an existing database read-only, takes a consistent SQLite read snapshot, and
never creates a directory, database, schema, campaign or controller. It returns:

- `store.path`: the canonical SQLite path; `store.id`: a hash of its file identity and path,
  stable during WAL updates (not a content checksum or a persistent identity across relocation).
- `dataSource`, observation time, campaign, controller instance, generation and controller code
  revision recorded by the lease. The invoking CLI checkout may have a different revision.
- `phase`, task states, operation IDs/task IDs, run cap/usage, blocker, next wakeup, quota wait,
  last progress time and last journal event metadata. Journal details, packets, worker output,
  session IDs and workspaces are excluded from the operation/event summaries.
- `ci` per published commit task and for the campaign: the CI result last recorded for the
  published head, or `unknown` (section 3, "CI repair of a published PR").

`ACTIVE` means an unexpired controller lease was observed, not that a model worker is running.
The controller renews this lease while polling. A killed controller can appear active until
that lease expires; status does not probe/kill processes or take over leases.
`CONTROLLER_OFFLINE` means a previously acquired lease expired (including orderly release).
`BOOTSTRAP_REQUIRED` means no lease has ever been acquired. With no live controller,
`recordedStatus` retains the historical campaign status while `status` says `controller-offline`;
paused/terminal control states retain their own readiness. A cancelled campaign reports
`status` and `recordedStatus` as `cancelled`, whatever status was stored before the cancel; the
stored row and journal stay unchanged. `lastProgressAt` excludes lease
acquisition, so a heartbeat alone cannot masquerade as task progress.

Errors are evidence-specific:

| Result | Meaning / next action |
| --- | --- |
| `STORE_NOT_FOUND` | No database at the selected path. Inspect the installed task; do not register a replacement campaign. |
| `CAMPAIGN_NOT_FOUND` | The existing selected store has no such campaign. Compare its path with the task; this alone does not prove the controller is down. |
| `DATA_DIR_MISMATCH` | Explicit `--data` and `AIWORKS_DATA` resolve to different directories. Correct/unset the stale shell value before retrying status. |
| `CONTROLLER_OFFLINE` readiness | Lease expired. Inspect the actual process and open operation ownership before considering recovery. |

Explicit selection is required; status never searches for another store and silently switches to it.
It does not reset run counts, replay operations, resume a campaign, or bypass provider waits.

### Cost and outcome baseline

`baseline` prints what the supervisor's work has cost and how often it was accepted, from any store, without changing it ([MODEL_ROUTING.md §8](design/MODEL_ROUTING.md#8-baseline-before-any-saving-is-claimed)). No routing saving may be claimed before this baseline is recorded.

```sh
node src/supervisor/cli.mjs baseline --data C:/example/aiworks/.local/supervisor [--since 2026-10-12] [--json]
```

- It opens the store read-only in one snapshot, like `status`, and makes no model, network or GitHub call. A store of another version is refused (`Unsupported store version`); a missing one is `STORE_NOT_FOUND`.
- It prints a short table, then the JSON report (`--json` prints the report only). Rows are per stage, risk, size, provider and model; accepted outcomes are per class and per implementing provider and model.
- Dollars are shown as the CLI reported them, never as spent. Tokens stay per provider. A run with no reported dollars counts as unknown, never zero, and dollars and tokens are never added together.
- Refunded runs (refused before any work) are left out and listed separately.
- An operation with a routing receipt is attributed to the model its receipt chose. An older one is inferred from the declaration and its `executor-amended` journal entries; a provider without a declared model shows `cli-default (unknown)`.
- What it cannot measure is listed in the report (`cannotMeasure`).

### What fills workers' context, and cheaper declarations

Most of a worker's cost is its context: the CLI re-reads everything said so far on every turn, from its cache. `worker-reading-cost` shows what fills it, measured from the workers' own session transcripts. Run it before and after a change meant to cut cost.

```sh
node scripts/supervisor/worker-reading-cost.mjs --data C:/example/aiworks/.local/supervisor [--hours 48] [--transcripts <Claude projects directory>] [--json]
```

- It opens the store read-only and finds each finished operation's transcript by its session id (default `~/.claude/projects`). It makes no model, network or GitHub call.
- It reports, by kind of tool result (shell reads, Read, git, gh, tests, browser and so on): calls, characters, share, and share weighted by the turns that re-read it.
- Per role, it reports whole-file re-reads, whole-file reads over 20 KB and full `git diff` or `show` output.
- It reports the share of reported dollars spent on repeated runs: each task's later implement and verify runs.
- A screenshot counts as an estimated 1,600 tokens, not its base64 length. Dollars are as the CLI reported them, and unknown is never zero.
- Test output is small: the gate helper returns only the summary block. Reading files and diffs is most of the context.

Three habits keep a declaration cheap without narrowing what a worker or verifier must do:

- **Reference sections, not whole documents.** A long design or runbook can be referenced as `path#slug`, so the implementer reads that section; the verifier still reads every referenced document in full ([SCOPED_READING §5](design/SCOPED_READING.md#5-what-each-role-is-told)). `section-ref` lists a document's slugs with their lines and checks one before it goes into a declaration:

  ```sh
  node scripts/supervisor/section-ref.mjs docs/SUPERVISOR.md --rev main            # every section, with its lines
  node scripts/supervisor/section-ref.mjs docs/SUPERVISOR.md#1-boundary --rev main # exit 1, with the reason, if it is not there
  ```

  A generator can import `sectionReference(path, slug, { repo, rev })` from the same file.
- **Declare `writes`** on every commit task, using directory prefixes where a task needs room. Without it a task owns the whole repository, and with the scheduler on it waits for every other commit task to be integrated.
- **Do not run two campaigns that change the same files at the same time** unless the scheduler is on and both declare `writes`. Otherwise every merge moves main under the other campaign's task, and an integration repair round runs again.

## 6. Installation and maintenance

Keep AIWorks-owned local files under the AIWorks root, outside version control:

| Path | Purpose |
| --- | --- |
| `C:/example/aiworks` | AIWorks source and development checkout |
| `C:/example/aiworks/.local/runtime` | Detached checkout of a merged, independently reviewed commit on main; the supervisor and dashboard run from here |
| `C:/example/aiworks/.local/supervisor` | Data directory: `config.json`, SQLite state, journal, log and run artifacts |
| `C:/example/aiworks/.local/worktrees/<repo>` | Supervisor-created implementation and verification worktrees; `aiworks/coordinator` is the coordinator's checkout (section 9) |
| `C:/example/aiworks/.local/governance` | Governance checkout: a plain clone of `example-org/governance` main, read-only to AIWorks |
| `C:/example/<project>` | Target repository checkout, outside AIWorks |

For SampleApp, `config.json` keeps `repositories["example-org/sampleapp"].path` at `C:/example/SampleApp` and sets `worktreeRoot` to `C:/example/aiworks/.local/worktrees/SampleApp`. Use the same layout for future targets. `.local/` is already ignored; never commit local state, logs, prompts or provider credentials.

- **Pinned checkout.** Run from a detached worktree pinned to a merged, independently reviewed commit on main, never from a development branch. Unmerged code starts no new work, and its `start` refuses every declaration (section 1).
- **Data directory.** Holds `config.json`, which names the governance checkout, maps each target repository to a local checkout and a worktree root, and gives absolute executable paths. Execution requires Windows and Node 22.5 or newer (`node:sqlite`), with the repository dependencies installed.
- **Install.** `scripts/supervisor/install-windows-task.ps1` registers the per-user logon task `AIWorks Supervisor`, which runs `cli.mjs keep` hidden. `keep` restarts `serve` after any exit. The dashboard runs as a separate per-user task, `AIWorks Dashboard`, from the same runtime checkout; `scripts/supervisor/install-dashboard-task.ps1` registers it. Both scripts take `-DefinitionOnly`, which prints the task definition as JSON and changes nothing.
- **The dashboard's caller check.** Protected owner actions (local approval, rules, Apply, settings, alerts, Knowledge, the work list) run on a request only after the native Windows lookup places its caller outside every open AIWorks run: by its loopback connection, its parent chain and the runs' job objects ([OPERATIONS_DASHBOARD.md](OPERATIONS_DASHBOARD.md#a-project-without-github-plan-approve-review-and-apply-built-off-by-default)). Both tasks run as the same user in the same logon session, so the dashboard can open the runs' `Local\` job objects; when it cannot tell, it refuses (`APPROVAL_UNCHECKED`), including while any launched worker, verifier, coordinator or planning run has not yet recorded its complete runner identity. Start the browser from the desktop: a browser started from an elevated or service process is refused, because the dashboard cannot read the processes above it.
- **A stopped supervisor starts again** ([#18](https://github.com/example-org/aiworks/issues/18)). Each task has two triggers: at logon, and every 5 minutes with no end. `MultipleInstances IgnoreNew` makes the 5-minute trigger do nothing while the task runs. If `keep` or the dashboard has died, the next trigger starts it, so either is back within 5 minutes. This covers what the restart policy misses: Task Scheduler does not count a console-close or Ctrl+C exit (`0xC000013A`) as a failure, so it never restarted the task on 2026-10-12.
- **A STOP file keeps it stopped.** `cli.mjs stop` writes `<data>/STOP`. A `keep` started by the 5-minute trigger while STOP exists exits at once and writes nothing, so the log does not gain a line every 5 minutes. The dashboard task does not read STOP. Remove STOP, or run the installer or `deploy.ps1`, to start the supervisor again.
- **The log says why `keep` ended.** Before it exits, `keep` writes one line to `supervisor.log`: `keeper ending (pid N): <reason>; exit code C`. The reason is `STOP file present`, `received SIGHUP`/`SIGINT`/`SIGBREAK`/`SIGTERM` (a closed console or Ctrl+C), or `failed: <error>`. If its `serve` is still running, the line says so; `serve` gets the same console event and releases its leases itself. Only a forced kill ends `keep` without this line.
- **A stopped supervisor is reported.** `status` and the dashboard API (`supervisor.controller` in `/api/state`) report `supervisor.state`. It is `stopped` when a campaign needs a controller (registered, paused, cancelling, or with a pending outbox) and every lease, the coordinator's included, expired at least a minute ago. The message gives the last lease renewal: `supervisor stopped; last lease renewal at <time>`. A running controller renews those leases every tick, so it is never reported stopped. The minute's margin covers a restart taking over. Other states: `running` (a live lease), `restarting` (leases expired under a minute ago), `not-started` (no lease was ever recorded) and `idle` (no campaign needs a controller, so the leases prove nothing). The renewal time is the lease expiry minus `leaseMs`. That is exact when the supervisor died, and up to `leaseMs` early after a graceful stop, which expires its leases at once; `leaseEndedAt` is exact in both cases. `stopRequested` says a STOP file is present. The dashboard shows "Supervisor stopped. Last lease renewal …" as the first line of "Needs you". Owner notification ([#1](https://github.com/example-org/aiworks/issues/1)) does not carry it yet.
- **Single host.** If workstation is off, nothing runs. On restart it resumes from the store without any owner message. This is not high availability.
- **Other machines.** The owner's second PC (workstation) runs its own older supervisor and dashboard from the build used before AIWorks was split out. AIWorks does not manage it ([AW-006](DECISIONS.md#aw-006---no-cross-machine-dashboard-view), [AW-007](DECISIONS.md#aw-007---aiworks-is-a-standalone-product-separate-from-governance)).

### Governance checkout

AIWorks does not carry the portfolio registry or policies. It reads them from governance provider through a governance checkout: a plain clone of `example-org/governance` at main. These are the only files read from it:

- `registry/projects/*.json`: registered targets (section 1), each project's governance block and its release authorization;
- `policies/catalog.json` and the policy files it lists;
- `registry/agents.json`: the role catalog that task `role` values are checked against at registration (section 1), and the dashboard roadmap's assignments;
- `schemas/project-contract.schema.json`;
- `docs/PRODUCT_ROADMAP.md` and `docs/AUTONOMOUS_ROLLOUT.md`, the dashboard's roadmap sources.

Configuration:

- The supervisor reads `"governanceRoot": "<absolute path>"` from the data directory's `config.json`.
- `start` reads the same `config.json` from `--data` or `AIWORKS_DATA` when it exists, and also accepts `--governance <path>`.
- The dashboard takes `--governance <path>`, defaulting to `governanceRoot` in the data directory's `config.json`.

Anything that needs the governance checkout fails closed without a valid one, and never falls back to the AIWorks code:

| Error | Meaning |
| --- | --- |
| `GOVERNANCE_ROOT_REQUIRED` | Nothing is configured: no `governanceRoot` in `config.json` and no `--governance`. |
| `GOVERNANCE_ROOT_INVALID` | The path is not absolute, or it has no `registry/projects` directory. |

`start` then refuses to register a new campaign. Dispatch raises the B2 `project-governance` blocker (section 1). The dashboard's roadmap panel says "governance checkout not configured".

The worker-context runtime is part of AIWorks: `scripts/lib/worker-context.mjs`, `registry/worker-context-policy.json` and the two worker schemas are read from the AIWorks code, not from the governance checkout.

AIWorks never writes to the governance checkout. The operator updates it by pulling governance provider's main; `scripts/supervisor/deploy.ps1` does this on every deploy (fast-forward only, refusing local changes); `npm run rebuild` never does. With `-Main origin` (the default) a failed pull stops the deploy, as before. With `-Main local` a failed pull keeps the checkout at its current commit and the deploy writes a warning naming that commit; the network is then not on the deploy's critical path, and a governance change takes effect at the next successful pull. Local changes still stop the deploy in both modes. A registry change takes effect for new registrations and dispatches once pulled. The dashboard reads release authorizations once at start, so restart it to pick up such a change.

### Upgrade

The live runtime changes only through this procedure. The supervisor never upgrades itself. Only one session restarts the runtime at a time.

`npm run rebuild` ([Rebuild](#rebuild-the-upgrade-as-one-command)) runs steps 1 to 6 as one command and is the normal way to upgrade; the steps below are what it does and the manual fallback.

1. **Baseline.** Run `status` for every campaign that is not finished, from `.local/runtime` with the live data directory, and keep the output.
2. **Pause.** Pause each of those campaigns, or press *Pause all work* on the dashboard's Home, which pauses every running campaign in one version-bound request and shows each as stopping until its open runs end. A worker already running finishes and its result is recorded, but nothing new is dispatched or published. Wait until no operation is open. *Resume all work* later resumes only the campaigns that Pause all work paused. A paused campaign without a blocker then shows `nextAction` "Paused by the owner; start the campaign again to resume."
3. **Choose the commit.** With `origin` trust, fetch, then take the hash from `git rev-parse origin/main`. With local trust (`selfHosting.trustedMain: "local"`), take the first line of `node src/supervisor/cli.mjs trusted-main --data <data>`, never raw `git rev-parse main`: a commit on local `main` that the main ledger does not record is not trusted. Never type a hash by hand. The commit must be merged to the trusted main, and a change to `src/supervisor` must have an independent review approving that exact commit.
4. **Deploy.** Run `powershell -NoProfile -File scripts/supervisor/deploy.ps1 -Sha <hash>`, adding `-Main local` with local trust. Without `-Sha`, `-Main origin` (the default) fetches and takes `origin/main`, and `-Main local` takes the trusted tip from the pinned runtime's `cli.mjs trusted-main` and does not fetch. With `-Main local` the deploy refuses, before it disables or stops anything, when that command fails or when `-Sha` is not the trusted tip or an ancestor of it. It disables both tasks, so their 5-minute trigger cannot start anything from a half-updated runtime. A task that does not exist is skipped. If disabling fails for any other reason, such as access denied, the deploy stops there with `deploy stopped: could not disable task …`, before it writes `STOP` or stops anything; a `STOP` left by an earlier failed deploy stays. Then it writes `STOP` and waits until the old processes are gone, stops both tasks, points `.local/runtime` at exactly that commit (detached) and runs `npm ci`, and fast-forwards the governance checkout. Last, it removes `STOP`, enables both tasks and starts `AIWorks Supervisor` and `AIWorks Dashboard` again. It stops at the first failure. Because it stops the supervisor before the checkout, a bad hash leaves it down until fixed: the tasks stay disabled, `STOP` stays, and `status` reports the supervisor stopped. Run `deploy.ps1` again once the cause is fixed.
5. **Resume.** Run the deployed runtime CLI with each campaign's identical private declaration, using the same data directory. Canonical scope, authorization version, tasks and progress must match the baseline. No declaration is copied into public source or required on main.
6. **Compare.** Run `status` again. Compared with the baseline, only the controller revision and lease generation should change.

**Applying new task definitions.** `deploy.ps1` changes the code the tasks run, not the tasks themselves. When a deployed commit changes `install-windows-task.ps1` or `install-dashboard-task.ps1`, rerun both from the runtime after step 4, while the campaigns are still paused: `powershell -NoProfile -File .local/runtime/scripts/supervisor/install-windows-task.ps1 -Checkout C:/example/aiworks/.local/runtime -DataDir C:/example/aiworks/.local/supervisor`, then `install-dashboard-task.ps1` with the same arguments. Each replaces its task's definition and starts it. Check the result with `(Get-ScheduledTask -TaskName 'AIWorks Supervisor').Triggers`: it should list the logon trigger and the 5-minute repetition. Then continue with step 5.

The old version and the journal stay in place for recovery.

Campaign ids used before the split from governance provider must not be registered again. Their reports and comments on GitHub carry the earlier comment marker, which the AIWorks supervisor does not look for, so it would post them a second time.

Relocation is an operator maintenance action, not worker cleanup: pause admissions, drain open operations, stop the supervisor and dashboard, and verify the old processes are gone. Move registered worktrees with `git worktree move`, preserving HEADs and dirty files. Update repository configuration and the SQLite operation `workspace`/`run_dir` addresses, then move the closed state directory and update the scheduled-task action and dashboard launcher. Preserve declarations, task outcomes, scope/packet digests, authorization versions, budgets, retry timers and historical prompt/spec contents; paths inside historical text remain evidence of the original run. Resume only campaigns that were registered before maintenance. Verify Git worktree registrations, database integrity, artifact existence, service paths and dashboard connectivity before considering the move complete.

### Rebuild: the upgrade as one command

Run it from an operator checkout of AIWorks at exactly the trusted commit, with its dependencies installed. When local main is trusted and the installation config names a separate AIWorks source checkout, the command checks that checkout is clean and at the trusted version, then runs its rebuild command. `--root` names the installation root when it is not this checkout:

```powershell
git checkout --detach <trusted commit>      # the commit npm run rebuild names when the checkout is elsewhere
npm run rebuild -- --root C:/example/aiworks
```

The command and its helpers are tracked under `scripts/supervisor/`; no private `.local/rebuild.ps1` is needed on another PC. Pull the updated source and install its dependencies there. Each PC keeps its own `.local` installation and settings; do not copy another machine's private files. This command updates an existing installation; it does not perform first-time setup.

`--wait <minutes>` (default 240) bounds the wait for open runs; `--port` names the dashboard port when it is not 4318. The command never asks a question: it refuses, changes nothing and says why, or it runs to the end.

1. **Preflight**, before anything changes. The operator checkout and `.local/runtime` must be clean Git checkouts. The commit is the trusted main, never a typed hash: with `selfHosting.trustedMain: "local"` the trusted tip from the runtime's `trusted-main`, otherwise `refs/remotes/origin/main` after `git fetch origin`. Git reads run in `.local/runtime`, a worktree of the canonical AIWorks repository that shares its commits and refs, and never in the installation root, which may be a separate checkout without the new commits. The operator checkout must be at exactly that commit (`SOURCE_NOT_AT_TARGET`), because the code that pauses and resumes is the code it installs, and the runtime's repository must have it (`TARGET_NOT_IN_REPOSITORY`). A `STOP` with work still open is refused (`STOPPED_WITH_OPEN_WORK`): no supervisor would record that work. The rebuild holds the installation's runtime maintenance lock, `.local/runtime-maintenance.lock`, from preflight to the end, so only one session maintains the runtime. A lock held by another session is refused (`MAINTENANCE_IN_PROGRESS`) and never removed. A lock held by another running rebuild is refused too (`REBUILD_IN_PROGRESS`). A rebuild's lock whose process no longer exists is taken over.
2. **Pause and drain.** It records its private state in `<data>/rebuild/state.json`, then pauses every running campaign with the reason `AIWorks rebuild <id>`. A campaign that is already paused, cancelled or finished is left as it is, and so is its pause reason. A campaign registered during the wait is paused too. It waits, with the supervisor still running, until no campaign run, coordinator or planning run and no started release step is open, so each finishes and its result is recorded. Nothing is stopped under a running worker. If work stays open past `--wait`, it resumes what it paused and ends (`DRAIN_TIMEOUT`); nothing was replaced.
3. **Stop and prove the drain.** `deploy.ps1 -Step Stop` disables both tasks, writes `STOP`, and waits for the supervisor and dashboard processes of this runtime to exit, failing if they do not. The store is then read again. The running supervisor has no admission gate for its coordinator, program waves or reopened finished campaigns, so one of them can admit one more run just before `STOP`. If one did, the unchanged runtime starts again (`-Step Start`), records it, and the drain repeats.
4. **Back up.** A consistent copy of the drained store (`VACUUM INTO`) goes to `<data>/rebuild/<id>/supervisor.db`, with a snapshot of what must survive: every campaign's authority (scope digest, authorization version, declaration digest), runs and cost used, task outcomes, attempts and retry timers, recorded runs and journal history. The previous runtime commit is recorded as well.
5. **Install and check.** AIWorks has no bundle build: the runtime is the source at the commit plus its locked dependencies. `deploy.ps1 -Step Install -Governance no` points `.local/runtime` at the commit (detached) and runs `npm ci`. It refuses unless the supervisor is stopped. The governance checkout is never pulled or changed by a rebuild. The check then requires the runtime HEAD to be the commit and the checkout clean, and the installed CLI must load its dependencies and read the store (`cli.mjs program-status`).
6. **Start.** `deploy.ps1 -Step Start` enables and starts both tasks. A `STOP` that was there before the rebuild stays (`-KeepStop yes`), so a supervisor the operator stopped stays stopped. Otherwise the new supervisor must take a lease under the installed commit within three minutes. The dashboard is asked to answer on `127.0.0.1`, and the summary reports whether it did.
7. **Compare and resume.** The store is compared with the snapshot: a lost or changed authority, run, journal entry or budget record, or any change to a campaign that is still paused or cancelled, stops here and resumes nothing (`STATE_CHANGED`). Otherwise it resumes only the campaigns it paused, each with its identical registered declaration, and only where nobody changed it since: still paused, its latest pause still the rebuild's own, and its authority unchanged. A campaign the owner resumed, paused again, cancelled or amended meanwhile is listed under `kept` with the reason. The summary names the commits, the resumed and kept campaigns and the evidence folder.

**Failure and retry.** Every step is recorded before or after it acts, so running `npm run rebuild` again continues from the first step not finished and never repeats one that finished: it does not pause twice, back up twice or resume anything it did not pause. A failure up to step 3 leaves the runtime unchanged; from step 3 on, the supervisor stays stopped (tasks disabled, `STOP` in place) until a retry succeeds. The paused campaigns keep their pause all the while. A retry checks the clean checkouts again and keeps the commit the rebuild started with while it is still on the trusted main. After step 3 the trusted main is not read again, because the runtime may be half installed. The finished state, the backup and `steps.jsonl` stay in `<data>/rebuild/<id>/`. `steps.jsonl` holds every external command with its exit code and the end of its output. All of it is private installation data. Going back to the recorded previous commit is the manual procedure above, with `deploy.ps1 -Sha <previous commit>`.

**Hidden commands.** Node starts `powershell.exe` hidden. Every external command after that (Git, Node, `npm ci`) starts through `scripts/supervisor/hidden-exec.ps1` with `ProcessStartInfo.CreateNoWindow` on and `UseShellExecute` off, and its stdout, stderr and exit code are captured. `npm ci` runs through `node` and `npm-cli.js` where Node ships them, so no `cmd.exe` starts. `deploy.ps1` runs its own commands the same way.

### Local operation: rehearsal, switch on and switch back

Owner decisions (e), (f) and (l) of 2026-10-16 and 2026-10-17 ([AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception), [AW-005](DECISIONS.md#aw-005---runtime-code-must-be-merged-declarations-remain-private), [LOCAL_OPERATION](design/LOCAL_OPERATION.md)) let AIWorks's own repository trust local main, publish to the local work list, merge locally and clean up after finished work. The source is built and switched off. What is source-tested and what is not:

- **Covered by synthetic tests (observed in `tests/supervisor`):** the main ledger, the anchor and the trusted tip; runtime provenance against the trusted tip; bases, publication and the work list without a remote or `gh`; the import. The activation regressions in `local-merge.test.mjs` also check exact-tree local merges, owner changes, cancellation, lease loss and recovery without a second merge. `cleanup.test.mjs` checks preservation of changed files and ignored evidence, repository scope and recovery after an interrupted removal.
- **Not covered by an automated test:** `deploy.ps1 -Main local`, which drives the real scheduled tasks and must never run in a test or a rehearsal, and the procedure below.
- **Owner route (source-tested, `tests/dashboard/self-hosting.test.mjs`):** Settings › Connections shows the trusted tip and local `main` in full when `main` has commits AIWorks did not put there, with **Trust local main** (`POST /api/v2/settings/trusted-main`). The caller check runs first, then origin and CSRF as for every command; the request binds both tips it showed and its request id. In the transaction that appends the `owner` ledger row it checks again that the trusted tip and local `main` are still those tips and that `main` descends from the tip. A retry is answered from its receipt; a main already trusted records nothing. It moves no ref. Commits that change `src/supervisor/` are refused: they still need an independent review of their exact head (AGENTS.md), which the owner route never replaces.
- **Not installed:** nothing here switches an installation. The switch is the operator's session task, under this procedure, and its evidence stays private. A merged change is not a deployment.

The switch is a `config.json` change made through the upgrade procedure. It adds no owner gate: the owner sets `selfHosting`, the merge-gate opt-in and `cleanup` as for the merge gate today. Every existing rule keeps binding: independent approval of the exact head, the verified tree and the merge commit, merged runtime code (AW-005), pause, drain and stop before any change, identical private declarations on resume, and the owner's typed confirmation before any imported issue is closed. Before a switch, the change that switches a feature on brings back that feature's product-critical tests ([AGENTS.md](../AGENTS.md#validation)), and the full suite passes at the exact SHA to be deployed.

**Disposable rehearsal (before each switch).** Run the whole cycle on a throwaway copy, never on the live data directory, its scheduled tasks or the live checkout, and never with `deploy.ps1`, whose task names and process match are those of the live runtime.

1. Make a disposable root: a `git clone --no-hardlinks` of the AIWorks checkout into a new temporary folder, a detached runtime worktree inside it at the commit under test with `npm ci`, and a new data directory with a synthetic `config.json`: a fictional repository name, a copy of the synthetic governance fixture as `governanceRoot`, worktree roots inside the temporary folder, `selfHosting` with `"trustedMain": "local"`, the repository listed in `merges.repositories` with `delegatedTo: "supervisor"`, and for the cleanup rehearsal `"cleanup": { "enabled": true }`.
2. Anchor while still online: `git fetch origin` in the clone, make its local `main` equal `origin/main`, then `node <runtime>/src/supervisor/cli.mjs trusted-main anchor --data <data>`. Check that `trusted-main` prints that commit and `0 unrecorded commits`. Then go offline: remove the clone's `origin` remote, take the folder holding `gh` off `PATH` for this session, and point `commands.gh` in the synthetic `config.json` at a path that does not exist, so any GitHub call fails visibly.
3. Record `status`, `git worktree list` and the local `campaign/` branches. Start `serve` from the disposable runtime with the disposable data directory as a hidden child process, register a synthetic campaign of two tasks against the clone, and let it run: implementation, independent verification of the exact head, a `review` item in the local work list, a local merge commit whose tree is the verified tree and whose parents are the trusted tip and the verified head, a `gate-merge` ledger row, and `trusted-main` printing that merge commit.
4. Repair and restart: check that the second task, verified before the first merged, becomes an integration repair round with a fresh verification. Add a commit to local `main` by hand and check that it is reported as unrecorded, that the merge gate waits on it and that running work does not. Run `cli.mjs stop` while a task runs, confirm the processes exited, start `serve` again and check that the task resumes once: no second merge commit, ledger row, work-list comment or worker run for the same step.
5. Cleanup: check that each finished task's worktrees are removed with their gate files copied to the run directory and its merged branch deleted, that a worktree given an untracked file is kept and reported, that a branch the trusted main does not contain is kept, and that run directories and the store are untouched.
6. Switch back (below) on the disposable copy and check that `status` and the next run behave as with `origin` trust. Delete the temporary folder. Keep the rehearsal record private.

**Switch on, on the installation.**

1. Baseline: `status` of every unfinished campaign and the dashboard's Settings; for cleanup, the private counts and sizes of worktrees and local task branches.
2. Pause all work and wait until no operation is open (upgrade, step 2).
3. If the runtime does not already run the exact reviewed `origin/main`, deploy it with the upgrade procedure as it is.
4. For local trust: fetch, fast-forward local `main` to `origin/main` in the checkout that holds `main` (never a hand-typed hash), set `selfHosting` with `"trustedMain": "local"` and the merge-gate opt-in, run `trusted-main anchor` from the runtime and check that `trusted-main` prints the deployed commit. For cleanup limited to this repository: set `"cleanup": { "enabled": true, "repositories": ["example-org/aiworks"] }` with the registered repository name. Shared coordinator checkouts stay untouched while cleanup has a repository list.
5. Deploy: `deploy.ps1 -Main local` with local trust, otherwise the upgrade procedure as it is. It stops the supervisor, pins the runtime at the trusted main and starts the tasks again.
6. Resume each campaign with its identical private declaration and compare `status`: only the controller revision and lease generation change; campaign scope, authorization version, budgets, retry timers and task outcomes match the baseline. After the first cleanup passes, compare the counts with the baseline and check that every kept worktree still has its files.

**Switch back.** Pause and drain as above. Set `selfHosting.trustedMain` to `"origin"` (or remove `selfHosting`), and remove `cleanup` or set its `enabled` to `false`. `origin/main` must contain the commit to be deployed: with the backup on it may already; otherwise publish the trusted tip through the ordinary GitHub review and merge first, because runtime code must be merged into the trusted main. Deploy `origin/main` with `deploy.ps1`, resume with the identical declarations and compare `status` again. The main ledger and the work list stay in the store, with their items and numbers; nothing is deleted. The anchor is recorded once per ledger, so a later switch on trusts only commits the ledger already holds until the owner route exists. Removed worktrees do not come back by themselves; a repair round recreates the ones it needs.

### Scheduler: rehearsal, switch on and switch back (RUN10)

The scheduler (section 7) is built and off. Switching it on is one `config.json` change on an installation, made by its operator through the upgrade procedure after an independent review accepts the exact commit to be deployed. Merging this runbook switches nothing, and no installation is evidenced here.

- **Covered by synthetic tests (`tests/supervisor`):** admission rules, fair order, fan-out and the host ceiling (`scheduler.test.mjs`); write domains and their holders (`write-domain.test.mjs`); several open operations and cost reservation (`multi-op.test.mjs`); takeover, two controllers and cancellation with parallel work (`restart-parallel.test.mjs`, `restart-publish.test.mjs`). The activation cohort (`scheduler-activation.test.mjs`) runs actual `serve` controllers over four disposable campaigns: under host pressure nothing starts; an account at its learned limit of one runs one step at a time until a useful result raises it; a never-served project is admitted before a served one; an overlapping write domain waits until its holder is merged; the ceiling of two is never exceeded; and a controller killed with two runs open is replaced with each step dispatched and charged exactly once.
- **Not covered by an automated test:** a real host's memory, CPU and disk, a real provider's limits, `deploy.ps1`, and the procedure below.

**Configuration.** Only the `scheduler` key of the data directory's `config.json` changes; every other key, budget, provider setting and declaration stays as it is.

Before (today: the key is absent, or):

```json
"scheduler": { "enabled": false }
```

After:

```json
"scheduler": { "enabled": true }
```

No `maxWorkers`: the ceiling is the default, `clamp(floor(cores / 4), 1, 4)`. No `scheduler.pressure`: the default thresholds of section 7. No `providerAccounts`: every campaign using one executor kind on the host shares one account, as today. No new account, budget or declaration. A declaration without `limits.slots` keeps one operation at a time per campaign, so the switch runs different campaigns side by side, never two steps of one campaign. To see the ceiling the default gives on the host, run `node -e "const os = require('node:os'); console.log(Math.min(4, Math.max(1, Math.floor(os.availableParallelism() / 4))))"`.

**Disposable rehearsal (before the switch).** On the exact commit to be deployed, in a disposable checkout and never against the live data directory, its scheduled tasks or its dashboard: `npm ci`, then `npm run check`, which includes the activation cohort. Keep the summary with the private rehearsal record. A further rehearsal on a throwaway copy follows steps 1 to 3 of the local-operation rehearsal above, with `"scheduler": { "enabled": true }` in the synthetic `config.json` and two fictional projects.

**Switch on, on the installation.**

1. Baseline: `status` of every unfinished campaign, kept privately, and the ceiling the command above prints.
2. Pause all work and wait until no operation is open (upgrade, step 2).
3. With nothing open, change `config.json` from *before* to *after*. A running supervisor does not read it again; the restart in step 4 applies it.
4. Deploy the exact reviewed commit with the upgrade procedure, `deploy.ps1` (with `-Main local` under local trust). Run it also when the runtime already runs that commit: it is the supported stop and start.
5. Resume each campaign with its identical private declaration.
6. Compare `status` with the baseline: only the controller revision and lease generation change; scope, authorization versions, budgets, retry timers and task outcomes match. Each waiting step names one scheduler reason (section 7).

**Success criteria, over the first working day.**

- Open operations across all campaigns never exceed the ceiling, and no task ever has two open operations (`status` of each campaign lists its open operations).
- No step is dispatched twice and no run is charged twice: each campaign's `budget.runsUsed` grows by exactly its new operations, and each task has at most one PR or report comment.
- When two campaigns of different projects have ready steps and room under the ceiling, their operations overlap at least once.
- Host pressure and account limits only delay work: each `host-pressure` journal entry is followed by `host-pressure-cleared`, and the switch raises no new owner blocker.
- The supervisor log has no repeating `admission failed` line.

**Switch back (rollback).** If any criterion fails, or the computer is too busy for the owner: pause all work and drain as above, set `"scheduler": { "enabled": false }` (or remove the key), deploy the same commit again with `deploy.ps1` to restart, resume with the identical declarations and compare `status` with the baseline again. Every campaign then runs one operation at a time, as before. Nothing is deleted: the `capacity` rows (learned fan-out, account limits, the pressure episode) stay in the store, unused while the scheduler is off, and are read again if it is switched on later. To keep the scheduler but use less of the computer, set `"maxWorkers": 1` instead, through the same steps.

### Model routing: cohort, switch on, compare and switch back (MOD7)

Routed dispatch ([MODEL_ROUTING](design/MODEL_ROUTING.md), slice R7) is built and used only by a private declaration that carries `routing`. Using it is a declaration change the installation's operator makes after an independent review accepts the exact commit to be deployed. Merging this runbook switches nothing. No account's model list, billing, live cohort or measurement is evidenced here, and no saving is claimed.

- **Covered by synthetic tests (`tests/supervisor`):** the declaration fields and their refusals (`campaign-registry.test.mjs`). The activation cohort (`routing-activation.test.mjs`) runs a real controller over a disposable documentation campaign with three fictional models of one provider. A cold start takes the lowest eligible tier at the step's floor. A model the provider refuses waits alone, its run is refunded and the next eligible tier runs. Two rejected heads on a tier move the step up one tier, never down. Each verifier is a fresh session on the exact head, at tier 2 or higher even when a tier-1 model is eligible to implement and not waiting. Expected cost stays unknown, never zero, while there is no history. Every other run is charged exactly once within the declared run budget. An account usage limit holds every model on that login until it lifts. When every declared model is refused, nothing is charged and the step stops on one B2 blocker, without reaching for another model, provider or budget.
- **Not covered by an automated test:** which models a real account accepts, what a run really costs or is billed, `deploy.ps1`, and the procedure below.

**What the operator settles first, privately (MODEL_ROUTING Q1).** For each account the cohort uses: the model names its provider CLI accepts on that login, and whether the plan is flat or pay-per-use. Candidates are models of the providers the campaign already declares, on the logins already in use. Routing adds no account, login, subscription, provider, tool, permission or budget. On a pay-per-use account, declare candidates only when the campaign already has an owner-set `limits.maxCostUsd` and `unknownRunCostUsd`; otherwise keep today's single model. A model nobody has checked on the account may stay in the list: the first refusal makes it wait alone. A wrong list only costs refunded refusals, then one blocker. Until this is known, the cohort does not start.

**Live-routing consent (MODEL_ROUTING Q2).** Running routing on the live workstation runtime is an owner-reserved production change, separate from Q1. Before switching on, the operator confirms the owner's Q2 consent is already recorded (the recorded answer is the default: one cohort of AIWorks documentation and design campaigns first, compared with the baseline before wider use) and that the deployed commit was independently accepted on its exact head. A recorded owner authorization to activate covers Q1 and Q2 and is not asked again; ask only when it is missing or the cohort would go beyond what it names. This adds no gate, account, permission or budget.

**The cohort.** The smallest that section 8.4 can compare is one AIWorks campaign of at least 10 documentation and design tasks, all in one class, R0/C1. Each task:

- has `deliverable: "commit"`;
- declares `writes` inside `docs/` or `DESIGN.md`, outside every `sensitivePaths` prefix;
- has at most 5 references, at most 4 acceptance checks and at most one dependency;
- has no `requiresMergedDependencies`, `role` or task `routing`.

The campaign keeps its own limits; no other campaign or provider setting changes. A claim needs at least 10 accepted outcomes of that class on each side. With fewer in the baseline, the cohort may run as a functional pilot, but nothing is compared.

**Private declaration template.** All names are fictional. Use the models settled above, and keep the campaign's declared executor, including its `model`, which applies again when `routing` is removed. Every candidate's `kind` must be a declared executor provider. Declare at least one candidate of tier 2 or 3, because the verifier's floor is tier 2. Tier 1 is the cheapest model trusted with small documentation changes; tier 3 is the strongest.

```json
"routing": {
  "mode": "auto",
  "sensitivePaths": ["src/", "scripts/", "deploy/"],
  "pin": null,
  "candidates": [
    { "kind": "claude-cli", "model": "example-small-model", "tier": 1 },
    { "kind": "claude-cli", "model": "example-medium-model", "tier": 2 },
    { "kind": "claude-cli", "model": "example-large-model", "tier": 3 }
  ]
}
```

One task of the cohort, with the other fields every task of the campaign carries (such as its `issue`):

```json
{ "id": "D01", "title": "Explain the example flow", "deliverable": "commit", "goal": "Document the example flow in docs/design/EXAMPLE.md.",
  "dependsOn": [], "writes": ["docs/design/"], "acceptance": ["The flow is described", "Links resolve"], "references": ["AGENTS.md", "docs/design/EXAMPLE.md"] }
```

**Baseline (before).** On the installation, read-only, before the cohort is registered: `node src/supervisor/cli.mjs baseline --data <data dir> --json`, saved privately as the baseline report together with the `status` of every unfinished campaign. Its `tasks` list the accepted outcomes per class; count the R0/C1 ones.

**Disposable rehearsal (before the switch).** On the exact commit to be deployed, in a disposable checkout and never against the live data directory, its scheduled tasks or its dashboard: `npm ci`, then `npm run check`, which includes the activation cohort. Keep the summary with the private rehearsal record.

**Switch on, on the installation.**

1. Record the baseline as above.
2. If the runtime does not run the exact reviewed commit, deploy it with the upgrade procedure, and compare `status` afterwards.
3. Register the cohort campaign with `start <private declaration>` under existing owner authority. An existing campaign takes `routing` only by an amendment with a higher `authorization.version`, while paused and with no open operation (`ROUTING_HANDOVER_REQUIRED` otherwise; journal `routing-amended`). No `config.json` key changes.
4. Compare `status` of every other campaign with the baseline: nothing changes.

**Success criteria, while the cohort runs.**

- Every cohort operation carries a `routing-policy/1` receipt, and the model its `operation-recorded` journal entry names is the model the receipt chose (the dashboard shows each step's model).
- No step is dispatched twice and no run is charged twice. The cohort's `runs_used` grows by its counted operations only; a refused model's run is refunded (`run-refunded`).
- Waits do not spin. A refused model waits alone (`model-unavailable`) until a recheck, and an account limit holds the campaign until it lifts. Neither is followed by a run of the same model.
- Each verify run reviews the exact head in a new session. A move up (`escalation.escalated`) follows two poor results on a tier, never goes down and never leaves the declared candidates.
- Unknown cost stays unknown in the dashboard and the receipts, never zero.
- A B2 blocker *No authorized model is available for this task role* means the list is wrong for the account: correct it by amendment, or switch back.

**Compare (after).** When the cohort campaign has finished, take a second report, `baseline --json`, and save it privately. Then run `node scripts/supervisor/routing-comparison.mjs --before <baseline report> --after <second report> --cohort <cohort campaignId>`. It reads only the two files. It refuses a pair from different stores, or a baseline that already holds cohort outcomes. Per class, it prints each side's measures, or *not comparable* when a side has fewer than 10 accepted outcomes. The cohort side counts only the cohort campaigns, so other campaigns that ran meanwhile do not mix in. Claims follow MODEL_ROUTING 8.4:

- claim per class, only where the class is comparable;
- claim fewer runs, fewer repairs or less time per accepted outcome in those units;
- claim dollars only over runs that reported dollars, together with the share of unknown cost;
- on a *quality drop* (lower first-pass acceptance or more repairs), keep routing off for that class.

Publish the per-class result through the normal local publication of the work item, with no store path, account or campaign content. Until then, [STATUS.md](STATUS.md) claims no saving. routing-policy/1's acceptance priors remain the design's constants. Retuning them from the baseline would be a new policy version with its own review; this procedure does not change them.

**Switch back (rollback).** If any criterion fails or the comparison shows a quality drop: pause the cohort campaign and wait until it has no open operation. Then `start` it with its declaration without `routing` and a higher `authorization.version` (journal `routing-amended`), and resume it. Its steps run on the declared executor and model again, as before. Nothing is deleted: receipts, model waits and history stay in the store, and `baseline` still reports them. No other campaign and no `config.json` key is touched.

## 7. Evidence and remaining gates

`tests/supervisor/` cover the following with synthetic `claude`/`gh` executables and disposable git repositories:
- validation and immutable scope;
- `BOOTSTRAP_REQUIRED` versus `ACTIVE`;
- lease fencing;
- the serial DAG, repair rounds, retry/stall, auth, budget, owner-reserved, stale target, pause and cancel cases;
- real-process crash rehearsals: after checkpoint, after launch, during the worker, whole-tree loss, between push and PR, after a report post, and two concurrent controllers;
- the owner-intervention core (section 10): the alert outbox, its transports and a crash between send and record (`tests/supervisor/alerts.test.mjs`).
- work on a project without GitHub (`tests/supervisor/local-e2e.test.mjs`): a plain folder connected, its rules confirmed and a plan approved through the dashboard's code with a synthetic owner caller, run on AIWorks's copy to verified local candidates across a restart, with no `gh` call and the folder unchanged; no start without confirmed rules, with revoked or expired rules, from an AIWorks process, for a changed plan, twice from one approval, or for a local campaign registered by another path.
- the CAAM account profiles (section 13): two profiles running at once, each inside its own home folder and login while the host home stays untouched, a home that cannot be prepared, rotation, a usage limit moving a task to another profile with one commit and one PR, a restart with a run still open, a secret scan of the database, run files and log, and the `"caam": { "enabled": false }` rollback, were rehearsed before this public history began; that test file is not in this repository. Here `tests/supervisor/executors.test.mjs` covers launching inside a profile's own home, and the switch-on change brings the rest of the critical tests back ([AGENTS.md](../AGENTS.md#validation)).

They make no model, network or GitHub calls. They read governance files from a small fixture governance checkout under `tests/fixtures/governance/`, never from a real governance provider checkout.

**The test runner.** `npm test` (`scripts/run-tests.mjs`) runs the test files in three tiers ([#102](https://github.com/netbka/aiworks/issues/102)): *unit* files (pure logic, no process) 4 at a time first; then, side by side, *service* files (a dashboard server, the review fixture, git in disposable repositories) 4 at a time and *rehearsal* files (supervisor controllers, contained worker runs, the CLI, containment) 2 at a time, slowest first. A file is a rehearsal when it uses the process-starting exports of `tests/supervisor/helpers.mjs` or a `*-harness.mjs`, a fault, a fixture executable or containment. A file that starts any other child process, such as git or a synthetic executable, is a service file; only a file that starts none is a unit. Each rehearsal file takes its own temporary and data directories and ports the OS assigns, so two files never share state. Each file runs in its own process; its output appears whole when it ends, and a table of every file's time, slowest first, comes before the summary. `npm run test:quick` (`--tiers unit,service`) leaves the rehearsals out for a fast local pass; it is not the gate. `npm run test:affected` (`--affected [base]`, default `origin/main`) runs only the files that the changes since the merge base can reach, committed or not: each test reaches what it imports and every repository path it names, transitively, and a change to `package.json`, the lock file or the runner selects every file (`scripts/lib/affected-tests.mjs`). It is not the gate either. `AIWORKS_HEAVY_CONCURRENCY=1` runs the rehearsals one at a time in the order before #102; `AIWORKS_TEST_CONCURRENCY` sets the other two tiers. The last summary block, after `# all test files`, is the total of every file. The crash/restart rehearsal is three files (`restart`, `restart-publish`, `restart-parallel`) over one harness, so the longest cases run side by side. Since 2026-10-17 the suite holds only product-critical tests ([AGENTS.md](../AGENTS.md#validation)); a design document that names a test file describes the slice as it was built, and a file removed since is in git history.

**Several steps at once (built, off by default).** When the scheduler is on, steps that do not depend on each other and do not change the same files run at the same time, across campaigns and projects, and a busy project cannot hold up a quiet one. It is off unless the data directory's `config.json` says `"scheduler": { "enabled": true }`. Off, every campaign runs one operation at a time, exactly as before. Turning it on at an installation is a runtime configuration change its operator makes through the upgrade procedure ([section 6](#scheduler-rehearsal-switch-on-and-switch-back-run10), slice RUN10), with the default ceiling of [ADAPTIVE_SCHEDULER](design/ADAPTIVE_SCHEDULER.md#9-owner-reserved-questions) Q3.

How it decides (`src/supervisor/scheduler.mjs`, design [ADAPTIVE_SCHEDULER §4](design/ADAPTIVE_SCHEDULER.md#4-design)):
- Each tick, every campaign settles as before (results, publication, integration), but only lists its ready steps. One admission pass then orders all of them and starts **at most one** per tick, so lease renewals stay on time.
- Order: the project served least recently first, then the campaign served least recently, then verify before implement, then declaration order. "Served" is the newest operation's time, read from the store.
- A step starts only if all of these pass, checked from the store and again inside the transaction that records it. The first that fails is its one wait reason:
  - `already-running`: the step already has an open operation;
  - `campaign-fanout`: the campaign's learned fan-out is full. Fan-out starts at 1, rises by 1 after a useful result while a step of the campaign waited for it, falls by 1 on a failed run and drops to 1 on two failures within one backoff window. It never exceeds `limits.slots` (`"auto"`: the host ceiling). It is kept in the store's `capacity` table and journalled (`fanout-raised`, `fanout-lowered`);
  - `host-capacity`: open operations across all campaigns reached the host ceiling, `scheduler.maxWorkers` (1..32), default a quarter of the cores between 1 and 4. This protects the computer; it is not an AW-002 limit and never notifies the owner;
  - `host-pressure`: the pass's one host sample (`src/supervisor/host.mjs`) shows low free memory, CPU busy over a full window, low free disk on a worktree volume, or late runner heartbeats (thresholds in `config.json` `scheduler.pressure`). A signal that cannot be read gives none, and a sampler that fails stops the whole pass until a later one. Running work continues; each episode is journalled once (`host-pressure`, `host-pressure-cleared`). Like the ceiling, it is host safety, not an AW-002 limit;
  - `write-domain`: another step holds an overlapping write domain (section 1). A published change keeps its domain until it is in the base branch. While a step waits for one, the base is fetched at most once per `integrationPollMs`, and the holder's PR is read once (REST) to recognise a squash or rebase merge of its exact head;
  - `provider-cooldown`: every authorized provider for the step is waiting (section 4);
  - `provider-concurrency`: the account of the provider the step would get is at its learned limit. An account has no limit until the provider refuses a run for its usage limit; that sets it to half the runs then open on it (minimum 1), and a useful result while a step waited for it raises it by 1 (`account-concurrency-lowered`, `account-concurrency-raised`). A kind run under CAAM profiles is limited per profile instead;
  - `launch-turn`: admissible, but this tick already started one.
- With the scheduler on, a cost ceiling that is reached only because open runs are reserved waits for those runs instead of asking the owner (B3 comes when nothing is open).

`status` gives each waiting step one of these reasons with the next automatic action (slice RUN9, `src/supervisor/api.mjs`), and the dashboard shows it.

Not yet implemented:
- GitHub webhook intake and conditional-GET reconciliation (slice B);
- a notification transport verified against a real provider (the Telegram adapter is built off and tested only against a synthetic network, section 10), replies from a notification, and reminders/incident timing beyond the section 10 defaults ([example-org/aiworks#1](https://github.com/example-org/aiworks/issues/1));
- a project release to a real destination: the release code runs deploy, check and rollback through a project's own commands, switched off, and only the disposable rehearsal has run it (section 12);
- a host other than workstation.

The `claude -p` output shape was checked against Claude Code 2.1.295; the first live run is the canary for the real adapter.

## 8. Ordered CLI execution

`executor.kind: "cli-chain"` declares a `providers` array in priority order ([AW-008](DECISIONS.md#aw-008---workers-run-on-claude-then-codex-then-cursor) sets Claude, then Codex, then Cursor), with kinds `codex-cli`, `cursor-cli`, and `claude-cli`. Model names are optional for Codex/Cursor and explicit for Claude; Claude also declares its existing `permissionMode`. Configure absolute native command arrays under `config.json.commands.codex`, `.cursor`, and `.claude`. PowerShell/npm launch scripts must be resolved to their native executable and script arguments on Windows. No credentials are copied into the declaration or service config.

- **Codex:** `--no-daemon`, a fresh `exec`, `--ignore-user-config`, approval policy `never`, and the `read-only` or `workspace-write` sandbox. `--ignore-user-config` does **not** remove account-level connectors: a worker without `--disable apps` sees every `mcp__codex_apps__*` tool, including the owner's local control service connector (evidence: archived [PR #65](https://github.com/example-org/governance-archive/pull/65)). Every worker therefore runs with `--disable apps`, `multi_agent`, `multi_agent_v2`, `computer_use`, `browser_use`, `browser_use_external` and `image_generation`; `aiworks_repository` is the only MCP server. Windows explicitly selects the provisioned `windows.sandbox="elevated"` backend: ignoring user config must not disable native enforcement. Sandbox commands still run without administrator privileges; managed requirements and command rules remain enforced. The controller supplies a per-command Git trust reset plus the exact assigned checkout's canonical path with forward slashes, needed by Git 2.38.1 for the separate sandbox account; no global Git trust is written. No sandbox bypass, resumed conversation, or ignored denial rules. JSONL must contain one native thread and a successful terminal event; the final schema binds the supervisor nonce and packet digest. Unreported cost stays unknown. Its cached-input count is marked as a subset of total input rather than added twice.
- **Cursor:** sandboxed `ask` mode for report/verification roles. `--trust` applies only to the controller-created checkout of the explicitly authorized repository; it does not enable force/yolo or MCP auto-approval. Commit implementation is skipped until a scoped publication-denial adapter is available. Detected project/global extensions that cannot be scoped per invocation make the provider unavailable.
- **Claude:** the existing fresh `--session-id`, scoped permission mode, denied approval prompts, JSON schema, and publication/deployment deny list remain. Verifiers also deny edit/write/commit tools. Every Claude worker runs isolated from the host and the target project's Claude setup:

  - `--setting-sources ""`: no user, project or local settings, so none of their allow rules (SampleApp's include `ssh example-host:*`, `git push origin main` and issue comments) or hooks apply. Admin-managed policy settings still apply by design.
  - `--strict-mcp-config`: no MCP servers or claude.ai connectors such as local control service.
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: no saved memories. `--setting-sources` alone does not stop them: a SampleApp worker otherwise received the project memory naming its production ssh host.
  - Commands run in the foreground. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` removes background commands: in a headless run with a JSON schema, ending a turn while one runs makes the CLI demand the final result at once, so a verifier that backgrounded a 10-minute `npm run check` had to return `evidence-unavailable` after one pass. `BASH_MAX_TIMEOUT_MS=3600000` and `BASH_DEFAULT_TIMEOUT_MS=1800000` keep such a gate from hitting the 10-minute foreground cap. The prompt says so too. The operation timeout still bounds the whole run.
  - The `Skill` tool is denied (host skills, including the synced user skills folder, are unreviewed instructions). Remote shells (`ssh`, `scp`, `sftp`, `rsync`, also through the PowerShell tool) and cross-session, scheduling and orchestration tools are denied.
  - The target project's own Claude Code tuning is kept, and nothing else: exactly `CLAUDE_CODE_SUBAGENT_MODEL` and `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`, with validated values, from the `env` of its tracked `.claude/settings.json` as committed at the task base (read with `git show` from the main checkout, never the worktree a worker can change). SampleApp: subagent model `haiku`, tool concurrency 3. Its permissions and any other variable (executable paths, provider or endpoint switches, credentials) are not passed, so one worker cannot steer the next worker or the verifier.
  - Isolated sessions load neither `CLAUDE.md` nor the project's `.claude/agents`; only Claude's built-in subagents remain (`claude`, `Explore`, `general-purpose`, `Plan`, `statusline-setup`). A probe with a planted project agent confirmed it appears only without isolation. So agent-frontmatter hooks or MCP servers that a worker commits cannot reach the next worker or the verifier, and `--settings {"disableAllHooks":true}` switches off any remaining hook source as well. Every worker prompt names `AGENTS.md` and the nearest nested `AGENTS.md` explicitly, and routes the worker to the target project's declared authorities from the packet (section 1).
  - Workers never inherit the supervisor's own `CLAUDE_CODE_*` session variables (relevant if the supervisor is ever started from a Claude Code terminal); the runner adds only what the controller put in the run spec.

Every implementer and verifier prompt for a commit or report task, whichever provider runs it, says to copy test summary lines verbatim, and tells verifiers that a tally that does not match their own re-run of the same gate at the same head is a blocking finding ([#43](https://github.com/example-org/aiworks/issues/43)). Web-task prompts run no gate and do not carry these rules.

One full gate runs per head, the verifier's (owner decision 2026-10-17): a commit-task implementer prompt says not to run `npm run check` and to run the tests the change can reach instead, through the same gate helper (`npm run test:affected` where the repository has that script, otherwise the test files that cover the changed code), even where a finding asks for the full gate. The controller has only ever trusted the verifier's own gate run (#43), so the verifier's tally rule now compares only a command it ran too. Commit-task verifier prompts say that the full gate can take 20 to 30 minutes while other work runs. The verifier runs it only through the gate helper `src/supervisor/gate.mjs`, named by its absolute path in the prompt: `start` runs it as a separate process that records its own exit code, and `wait` returns when it ends, after at most 25 minutes with `running`, or at once with `died` when the gate process ended without an exit code. A worker then starts it once more instead of waiting out its time bound on a log line that cannot appear. It copies the final summary block verbatim, never shortening the suite ([#102](https://github.com/example-org/aiworks/issues/102)). Every file the gate writes ends in `.log`, which git ignores (`gate.log`, `gate-exit.log`, `gate-pid.log`, `gate-previous.log`): any other new or changed file in a verifier's checkout makes its result invalid ([#135](https://github.com/example-org/aiworks/issues/135)). Report and research-only prompts do not carry this rule.

**Gate slots.** Four full gates at once on one PC failed with out-of-memory and timing errors, and the supervisor refused those verifications. So the gate helper runs the command only while it holds one of `AIWORKS_GATE_SLOTS` machine-wide slots (default 2, at most 8). The slots are lock files in `AIWORKS_GATE_SLOTS_DIR` (default `aiworks-gate-slots` in the system temporary directory, which every worker account shares because accounts change only `HOME`). Until a slot is free, `gate.log` says the gate is waiting and `wait` reports `running`. The slot is given back when the command ends. A slot whose process is gone, that is older than four hours, or that has been empty for a minute is taken over. A gate started inside a gate, as the suite's own gate tests do, takes no slot. The limit is a throttle, not a lock: two gates taking over the same abandoned slot at the same moment can both run.

**The PR shows the tally the supervisor read, not one a worker typed ([#43](https://github.com/example-org/aiworks/issues/43)).** When a verification of a commit task ends, the supervisor reads the gate helper's files in the verifier's checkout: `gate-exit.log` for the exit code and `gate.log` for the final node:test summary block (the block after `# all test files`, else the last `# tests` ... `# duration_ms` lines; never other log lines). `gate.log` holds only the last gate run. Both are kept with the task's verification.
- The **Gate** section of the PR body shows that block verbatim, labelled as read from the verifier's gate output, with its exit code. Without a `gate.log` it says that no gate output was found. A gate without an exit code is shown as unfinished.
- An **accepted** verification whose last gate run exited non-zero, or whose summary reports `# fail` above 0, is refused as `invalid-result` with the summary as its detail. So is one with no `gate.log` or no exit code: implementers run only the tests their change reaches, so the verifier's gate is the one full run a head gets. The task goes back for a fresh verification, as for any other invalid result. A rejected verification stays rejected.
- Report tasks are not read, and a rejected verdict stands with or without gate files.

Verifier prompts for commit and report tasks also say that a check that behaves as intended is a pass. That includes a mutation or base comparison whose expected failure was seen, and a full-suite run whose only failure is an unrelated timing test that passes on a re-run. `fail` is only for an outcome that shows a defect in the change, and `accepted` never comes with a failed check ([#59](https://github.com/example-org/aiworks/issues/59)). Implementer and web-task prompts do not carry this rule.

**Workers read what they need, in parts, and never twice ([#14](https://github.com/example-org/aiworks/issues/14)).** Every implementer and verifier prompt for a commit or report task, whichever provider runs it, carries one reading rule, on its own line after the gate rules and before the packet:
- Find before reading: `grep -n` for the symbol, heading or test name, then read the lines around it. Read a whole file only when it is under about 300 lines or the task changes most of it.
- Do not read a file or command output again in the same session unless it changed since.
- Review a change starting with `git diff --stat`, then read the diff one file at a time, each file once.
- Filter long command output (`jq`, `grep`, `head`) instead of printing it whole. Never print `gate.log` whole: the gate helper already shows the summary.

The rule makes reading cheaper, never narrower. When it and another rule seem to conflict, the other rule wins, and the prompt says so. What a worker may read, run, change or decide is unchanged, and so are packets, packet digests, the gate rules and the reading guide. The verifier's version adds that it narrows nothing: every document in the packet references is still read in full, and the verifier's reader-of-record duty ([SCOPED_READING §5.2](design/SCOPED_READING.md#52-verifier)) stays word for word. Web-task prompts do not carry the rule. Why: over 96 worker sessions measured on 2026-10-16, verifiers' whole-file reads over 20 KB were 27% of their tool output, and full diffs 23%. It reaches workers only on a runtime that includes this change: merged is not deployed.

**A verifier retried after a refused result is told why ([#59](https://github.com/example-org/aiworks/issues/59)).** When the supervisor refuses a verification result as `invalid-result` (for example "accepted with a failed check" or "rejected without a blocking finding"), it records the refusal with the head it judged. The next verification of that same head gets one short controller note: `Controller note: the previous verification of <head> was refused as invalid-result: <detail>.` The note is one packet constraint, so the packet digest covers it, and the prompt states it again after the packet. The supervisor builds it from the recorded refusal only, with the detail cut to 300 characters. It adds no owner instruction and no reference. Task scope, acceptance, the no-progress guard (section 4) and the verifier's independence are unchanged. A verification of a new head carries no note.

Dated verification evidence for these rules lives in Git history and the PRs that introduced them, not in this runbook. For work before the split, that history is in the private archive `example-org/governance-archive`. Current status is in [STATUS.md](STATUS.md).

Changing only the executor chain requires a higher authorization version, a paused campaign and no open operation. Target, tasks and constraints remain immutable. The amendment journals both executor declarations and scope digests; existing tasks, costs, operation history and consumed budget are retained. An exhausted campaign does not resume merely because its executor changes.

Headless Codex with the elevated Windows sandbox cannot be relied on while the owner uses Codex interactively on the same host. The sandbox setup rewrites the ACL of Codex's runtime binary `node_repl.exe` before each command, and it fails with a sharing violation (`os error 32`) whenever another Codex process holds that file. The `sampleapp-443-waves` campaign therefore runs Claude first and Codex second. The adapter explicitly selects the already configured elevated sandbox backend; without that selection, restricted commands are refused under approval policy `never`.

The sandbox shell's `gh api repos/example-org/sampleapp --jq .full_name` check returned HTTP 404 while the owner-context command succeeded; the precise authentication/access cause remains unknown. Codex now receives an explicit read-only repository MCP capability backed by the trusted host GitHub CLI. The controller fixes the repository, run nonce, packet digest and absolute executable before dispatch. Only repository/issue/PR/comment metadata GET routes, PR reviews, and the commit status and check runs of a commit that heads a PR in the assigned repository are exposed, with bounded pagination. PR responses include draft, mergeable and mergeable_state; there are no model-supplied commands, URLs, credentials or mutations. Repository identity must succeed first, canonical response URLs must match, and upstream failures stop the reader without retry. Failed reader tools and denied native commands cannot turn into quota fallback. The reader and its CLI descendants remain inside the owned run containment. A contained workstation probe successfully read SampleApp identity and issue #438 through this capability. This verifies the explicit reader, not shell `gh` access.

A contained Windows commit probe failed creating the linked worktree's shared Git `index.lock` with permission denied. Codex commit implementation is therefore unavailable before admission on Windows. Codex also never verifies a commit task on Windows: its read-only sandbox cannot create `node_modules` or temp files, so it cannot run the repository's tests, and the chain skips it instead of spending a round ([#113](https://github.com/example-org/aiworks/issues/113)). Report tasks remain eligible in both roles. No Git-directory ACLs or sandbox write roots are broadened. Cursor commit roles also remain unavailable pending a scoped publication-denial adapter. Cursor Agent 2026.10.01 explicitly rejects enabled native sandbox mode on Windows, requiring macOS or Linux; the adapter records unavailability and never disables the sandbox. Its current global configuration also needs scoped review before use. Configured priority does not assert that all three providers support every role or host. These probes do not consume campaign worker runs.

Runner heartbeat and terminal receipts use atomic replacement. Windows readers can briefly lock a destination against rename, so replacement retries sharing/permission errors for at most one second. Exhaustion remains an error and preserves the previous complete receipt; no delete-and-rewrite fallback is used.

CLI references: [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode), [Cursor parameters](https://cursor.com/docs/cli/reference/parameters), and [Cursor permissions](https://cursor.com/docs/cli/reference/permissions).

## 9. Owner messages and the coordinator

The dashboard's **Message coordinator** button, and `cli.mjs message "<text>"`, send the owner's free-text request to a coordinator agent. Task instructions remain the separate per-task channel (section 3, delivered with the next matching worker run).

Each message carries a durable receipt in `owner_messages`, shown in the dashboard's **Messages** view and by `cli.mjs messages`:

| Receipt | Meaning |
| --- | --- |
| Received | The supervisor stored the message (idempotent per request id; at most ten waiting). |
| Read | A fresh coordinator session started with the message in its prompt (the contained runner confirmed the process). Its live turn and tool-call counts are shown while it works. |
| Answered | The coordinator returned a valid, secret-checked result; the supervisor saves the reply, reviewed-work table, plan and any draft campaign locally and shows them in the dashboard. No GitHub write occurs. |
| Retrying / Not answered | A read ended without a valid answer. It is retried once with a fresh session (quota and authentication waits retry after 30 minutes); after that the receipt says so and nothing is posted. |

While a dashboard tab is open, every receipt change (message received, read, answered; task instruction read; the worker that read it finished) shows a notice and, when the browser allows it, a desktop notification. Permission is requested when you send. There is no notification without an open tab until the owner notification channel is delivered ([example-org/aiworks#1](https://github.com/example-org/aiworks/issues/1)).

The coordinator is a single-slot lane with its own lease (`_coordinator`). Its slot is separate from campaign slots, and its reads never count against a campaign's limits (`maxWorkerRuns`, `maxCostUsd` or any other). They do count against a project's standing budget when they can be attributed to that project (`project_settings`, [OPERATIONS_DASHBOARD.md](OPERATIONS_DASHBOARD.md#project-settings-owner-ui-v2-wp5)): each read that drafts a work request for a project, retries included, and a message whose stored project names exactly one. A read that names no single project is charged to no project's budget and is shown apart. A read the project's budget cannot cover waits as received and starts by itself once the budget allows; a read that reported no cost, and every read still running, is counted at the project's price for a run with no reported cost; only a read that never started is free. It runs Claude headless with the same isolation as campaign workers, in Claude's `dontAsk` mode: every tool call not on an explicit allowlist is denied without a prompt.

- **Reads are confined to its own checkout.** The allowlist is `Read(./**)`, `Grep(./**)` and `Glob(./**)`. A workstation probe showed these allow the working directory and deny everything outside it, including the supervisor data directory, other repositories and `~/.claude`. Absolute denies such as `Read(//D:/...)` are not honoured on Windows, so confinement does not rely on them. Home-relative denies for credential stores (`~/.claude`, `~/.codex`, `~/.ssh`, `~/.config`, `~/AppData`) and `.env`/key patterns are defence in depth.
- **Commands are read-only GitHub and git queries:** `gh issue|pr list/view`, `gh pr diff/checks`, `gh search issues/prs`, `git status`, `git rev-parse` and `git ls-files`. There is no `gh api`, whose write flags can appear anywhere in a command, and no `git log/show/diff/grep`, whose output-file and external diff/pager options can write files or run programs. `git -C`, `curl`, `node`, `npm`, shells and web tools are denied.
- **Replies are gated before storage and display.** A reply containing a high-confidence credential format (GitHub, OpenAI or Anthropic tokens, AWS keys, private-key blocks, JWTs, Slack tokens) is withheld and the message is marked *Not answered* (`reply-withheld`).
- **What the policy must deny and allow.** It denies `.env` reads, reads outside the checkout, `gh api`, `git -C`, `ssh`, `curl`, `gh issue comment` and writes. It allows `gh issue view/list` and reads inside the checkout. Probe evidence: archived [PR #71](https://github.com/example-org/governance-archive/pull/71).

The coordinator never runs in the live runtime checkout. It uses its own detached worktree of AIWorks at the deployed revision (`.local/worktrees/aiworks/coordinator`, reused across runs). AIWorks is where campaigns are declared, so that is the checkout it reads. Before each read the supervisor checks that this checkout and the live runtime are clean at the deployed commit, and it checks again after each run. If the agent changed either, nothing it produced is posted, its messages are marked **Not answered** (`boundary-violation`), and the lane stays blocked even after the checkout is restored, until the owner runs `node src/supervisor/cli.mjs coordinator-clear --data <dir>`. The dashboard shows the reason. Invalid coordinator configuration also keeps the lane idle and is shown; it never falls back to defaults. `permissionMode` is fixed to `dontAsk`. Because only the coordinator's own checkout is readable, it reads other repositories only through `gh` and says what it could not check.
It reviews, classifies and plans; it never comments, registers or starts a campaign. The supervisor saves its checked final answer in `coordinator_replies`, in the same transaction as the answered receipt. Each run handles one request. Dashboard plan requests retain their selected repository in `owner_messages.repository`; requests queued before this field existed recover it from the fixed dashboard header. The prompt scopes its inventory and proposed campaign to that project. `config.json` enables it:

```json
"coordinator": {
  "repositories": ["example-org/aiworks", "example-org/governance", "example-org/sampleapp"],
  "model": "opus", "timeoutMinutes": 60
}
```

`reportTo` is optional and accepted only for compatibility with old configurations. No new coordinator answer uses it. Old posted reply links remain readable; pending coordinator outbox entries are retained locally instead of sent to GitHub. Campaign comments and PRs still use their declared target repository. The store migration is additive, and read-only dashboard access also works before migration.

Without that block, messages stay **Received** and the dashboard says that no coordinator is configured. There is no daily cap unless `maxRunsPerDay` is set; then waiting messages are read when the 24-hour window frees a run. A read refused by a provider usage limit is retried after 30 minutes.

## 10. Owner-intervention core

Tracked in [example-org/aiworks#1](https://github.com/example-org/aiworks/issues/1). Implements the store/controller half of the portfolio [OWNER_INTERVENTION.md](https://github.com/example-org/governance/blob/main/docs/OWNER_INTERVENTION.md) contract (OPS-001 invariants `b0`-`b5`, `dedup-anti-spam`, `owner-done-triggers-recheck`, `reminder-limits`, `blocker-record-sensitive-data-exclusion`). It is **off by default**: with no `ownerIntervention` block in `config.json` the controller behaves exactly as sections 3-4 describe. Enable it with:

```json
"ownerIntervention": { "enabled": true }
```

Durable state (additive SQLite tables, created idempotently whenever a writer opens the store; the store version is unchanged, older code ignores them, and read-only status of an unmigrated store simply shows no blockers):

- `blockers`: one row per fingerprint, `sha256(project, environment, dependency, class, failure-identity)` over redacted text. The identity is structured where possible (executor kind for `auth`, operation id for `process-ownership`, authorization version and cap for `budget`, task and redacted trigger for an owner decision). Summary, requested action, identity and evidence are passed through `redact()` (tokens, keys, bearer/basic values, `name=value` secrets, URL credentials, PEM blocks, opaque mixed-case runs); Git SHAs stay readable. No secret value is stored or hashed.
- `blocker_parents`: every task the blocker holds, per campaign, with the phase it resumes in.
- `owner_notifications`: the notification outbox — what would be sent under section 8 of the contract, keyed `<fingerprint>:<episode>:<initial|reminder-n>`.

Semantics:

| Event | Effect |
| --- | --- |
| B0/B1 (usage-limit wait, retry/backoff, provider fallback, evidence-unavailable rerun) | Unchanged; never a record or notification. |
| B2-B5 raised (campaign blocker, or a task's owner-reserved / no-progress B3) | Open the record, attach parents, record one `initial` notification. B4 is recorded as awareness without an action; B5 has no timer. |
| Same fingerprint while open or rechecking | Same record: occurrences + 1, parents attached, no new notification, no new tracking-issue comment. |
| Changed cause (class, dependency, identity, project or environment) | New fingerprint, record and notification. Recurrence after resolution opens a new episode of the same fingerprint with its own notification. |
| `blockerAcknowledge` (API) | Records `acknowledged_at`. Never rechecks, resolves or resumes. |
| `recheck` (owner Done) or a due timer | Deterministic probe (`budget`, `process-ownership`, or a synchronous probe injected as `probes[dependency]`) decides at once. Otherwise one held parent task is released as the probe run and the others stay held. A timer never starts a probe run. |
| Probe passes (deterministic evidence, a structured result from the probe run, a successful publication, or the owner decision recorded by `recheck --task`) | Record resolved with its evidence, parents released in the phase they were blocked in, tracking-issue resolution comment. Other campaigns holding the same fingerprint adopt the resolution on their next tick. |
| Probe fails (same failure recurs, probe says no, no runnable parent) | Same record stays open with the new evidence and `recheck_attempts + 1`; no new notification. |

Recheck schedule (deterministic probes only): B2 15 min, 60 min, 4 h, then owner-triggered only; B4 1, 5, 15 min, repeating at 15 min; B3 and B5 none. Reminders: B2/B3 one after 60 min, then at most once per 24 h; none for B4/B5.

Crash and restart: every record, parent, probe and notification change commits in the same fenced transaction as the campaign/task change it belongs to. A probe run is an ordinary recorded operation, so a restart between checkpoint and launch launches the same operation once (rehearsed before this public history began; that test file is not in this repository); held tasks stay held until the probe's result is applied. A `rechecking` record whose probe task is waiting (backoff or usage limit) keeps holding the others.

Notification delivery: a transport is `{ name, live, dedup, send({ key, message, alert }) }`, where `alert` is the rendered, redacted title, lines and dashboard-address buttons (`alerts.mjs renderAlert`). Without a transport the no-op one stays (`live: false`), entries stay `pending` and nothing leaves the host. A live transport sends only with `"deliver": true` beside `"enabled": true`. The attempt is counted before `send`. A transport that deduplicates by key (`dedup: 'key'`, the rehearsal one) is simply tried again after a crash (at-least-once). One whose provider cannot deduplicate (`dedup: 'none'`, Telegram) marks the entry `sending` before the call, and every answer is classified:

| Answer | Entry | Sent again? |
| --- | --- | --- |
| The provider accepted it | `delivered` | No |
| Nothing reached the provider: a reference that does not resolve, a secret store that cannot tell, a connection never made, or a rate refusal (HTTP 429) | `pending`, backing off by `outboxRetryMs` × attempts, `failed` after 5 attempts | Yes, bounded |
| The provider refused it (HTTP 4xx) or a resolved value is malformed | `failed` at once | No |
| It may have arrived: a time-out, a reset, HTTP 5xx, an unreadable answer, an entry still `sending` after a restart or a lost lease | `unknown` (journal `owner-notification-unknown`) | Never |

So an uncertain alert is never duplicated, and it is never lost either: the blocker it announced stays in Needs you, and its reminders, if on, are new messages under their own keys. A rate refusal waits the outbox backoff, not Telegram's `retry_after`.

Alert rules and transports (OWNER_UI_V2 WP6, `src/supervisor/alerts.mjs`): before each send the owner's newest `alert_rules` decide. An entry whose class or reminders are off is closed as `muted` and never sent later; one inside quiet hours stays `pending` with no attempt counted and goes out when they end (an incident only breaks quiet hours when the owner allowed it). The per-blocker deduplication above is unchanged: one notification per fingerprint and episode, whichever transport is chosen. The operator chooses the transport in `config.json`:

```json
"alerts": { "transport": { "kind": "synthetic" } }
```

`synthetic` records each rendered alert once per notification key in `alert_rehearsals` and marks the entry `rehearsed`, never `delivered`; a retry after a crash between send and record finds the key and records nothing new.

**Telegram** (`src/supervisor/alert-telegram.mjs`) is the one adapter that leaves this computer. It is built and off: nothing turns it on but the operator's own setting, and with any part of it missing nothing is sent. It needs all three of:

```json
"ownerIntervention": { "enabled": true, "deliver": true },
"alerts": { "transport": { "kind": "telegram", "secretRef": "windows:aiworks-alerts/bot", "recipientRef": "windows:aiworks-alerts/chat" } }
```

- **References, never values.** `secretRef` names the bot credential and `recipientRef` the chat, each in a secret store the operator owns: `windows:<name>`, a generic credential in the Windows Credential Manager (read with `CredRead` in a hidden PowerShell child), or `helper:<name>`, the operator's credential helper (`commands.credentialHelper`, a native command asked `get <name>`, the contract of `release/credential.mjs`). The names above are examples. They are resolved inside each send only, for that one request, and their values are never stored, logged, journaled, served by the dashboard or put in an error; Telegram's own error description is cleaned of both before it is kept. A credential value in the setting reads `invalid`; one reference missing, the same reference twice, or another store reads `incomplete`. Settings › Alerts shows `ready` (sending switched off) or sending, and never a reference.
- **What is sent.** One plain-text `sendMessage` to `https://api.telegram.org` per entry, with link previews off, no markup and no buttons; dashboard addresses are written out as places on this computer. Redirects are refused and a request is bounded to 15 seconds.
- **No authority.** The adapter never calls `getUpdates` or registers a webhook, so no reply reaches AIWorks. An alert cannot approve a plan, answer a decision, accept a result or vouch for its sender; every such act stays a protected local dashboard route with its caller, CSRF and version checks until remote access is separately designed and approved (WP10, AW-003).
- **Provider deduplication.** Telegram's Bot API has no idempotency key, so it cannot drop a repeated message: AIWorks's own `unknown` state is the only protection against a duplicate, and an `unknown` alert is not resent even when it never arrived.
- **Evidence.** `tests/supervisor/alerts.test.mjs` drives the production selection path (`configuredTransport`) with a synthetic secret store and a synthetic network: nothing is resolved or sent without the full setting; a delivery is recorded once with no value or reference in the store, journal or log; a time-out, an HTTP 5xx and an interrupted send end `unknown` and are never repeated; a refused connection is tried five times; a refusal stops at once. No check reads a real credential or sends a real message, and none has run against Telegram itself: whether a real bot and chat accept these requests is unknown until the operator's own canary.

Any other kind (`{ "kind": "<name>", "secretRef": "<store>:<path>", "recipientRef": "<store>:<path>" }`) has no adapter and reads `unavailable`: nothing is sent and the references are never resolved, served, logged or journaled. A setting holding anything but such references, such as a credential value, reads `invalid` and sends nothing. Settings › Alerts shows these states and never claims a delivery that did not happen.

Before delivering on an installation, the operator, not this repository: creates the bot and puts its credential and the owner's chat id into the secret store under the chosen names; confirms the schedule defaults, the snooze policy and the B5 incident path; and then sets `deliver` and the transport through the upgrade procedure, watching the first alerts as a canary. Remote access and replies stay WP10's owner decision.

## 11. Web acceptance by the AGY browser worker

A task that declares `web` is a web acceptance task: a browser worker opens the declared pages, checks every acceptance criterion as a user would see it, and reports. The task must be a `report` deliverable, and the campaign's executor must include a browser worker: `agy-cli` (the Antigravity CLI, `agy`) with a pinned `model`, or `claude-cli` without `researchOnly`.

```json
"web": { "urls": ["http://127.0.0.1:6006/?path=/story/checkout"], "resourceOrigins": ["https://fonts.gstatic.com"] }
```

- **Scope.** `urls` lists 1-8 http(s) pages, without credentials. The browser can load only their origins and the optional `resourceOrigins` (fonts, CDNs), and the agent can navigate only to their hosts. Both belong to the immutable scope, so a new page or origin needs a new campaign. Any http(s) origin may be declared, public sites included, except the ports of the owner's control planes on this host: port 4318 (supervisor dashboard) or 17321 (local control service) is refused on any host, because loopback has too many spellings to list (`localhost.`, `foo.localhost.`, `[::ffff:127.0.0.1]` all reached a loopback service).
- **Routing.** Only the browser workers run a web task, for acceptance and for its independent verification, in the declared order. With `agy-cli` before `claude-cli`, AGY reviews when it can. When AGY waits on a usage or credit limit, is not configured, or failed its last attempt, Claude takes the task instead of the campaign waiting. `agy-cli` runs no other task. The verifier is a fresh browser-worker session that re-opens the pages and re-checks each claim of the report; a false pass or a false fail is a blocking finding and starts a repair round.
- **Report.** Its first line is `**Visual acceptance: ACCEPTED**`, `REJECTED` or `INCOMPLETE`, followed by a table of criterion, result and evidence. Publication posts it to the task issue like any report; a rejected view is a completed review, not a failed task.
- **Isolation.** Every per-user folder of a run is inside its run directory: `USERPROFILE`/`HOME` (its own AGY profile home), `APPDATA` and `LOCALAPPDATA` (empty folders under that home), and `TEMP`/`TMP`. The owner's AGY settings, grants, MCP servers, memories and conversations never load, and neither the owner's `%TEMP%` nor the Antigravity app's storage is reachable; the login comes from the OS keyring. The runner's PowerShell helper resolves its known folders inside the same home, so nothing is written to the runner's working directory. The settings deny shell commands, file reads and writes, AGY's own URL reader and the browser's `upload_file`, and allow only the `browser` MCP server and the declared hosts. The working directory is an empty scratch directory, so no repository checkout is reachable. The prompt spells out the run's `runId` and `packetDigest`, which the result schema binds.
- **Claude as browser worker.** On a web task Claude keeps the usual worker isolation (no setting sources, `--strict-mcp-config`, no hooks, no auto-memory) and additionally gets:
  - `--tools ""`: no built-in tool at all, so no shell, files, web search or subagents;
  - the run's browser server as its only MCP server;
  - `dontAsk` permission mode with only the browser tools listed, and `upload_file` denied;
  - an empty scratch working directory.

  A workstation probe confirmed that such a session lists only `mcp__browser__*` tools. Its declared `permissionMode` applies to its other tasks only.
- **Browser.** The only MCP server is `src/supervisor/browser-mcp.mjs`. It sets the run's own temporary folder before chrome-devtools-mcp loads; the package adds `os.tmpdir()` to the folders its file tools may use, so together with `--workspace` no file tool reaches outside the run directory. It starts a headless Chrome with a fresh profile in the run directory and a loopback debugging port, under the same run-local environment, with WebRTC limited to proxied UDP (`--webrtc-ip-handling-policy=disable_non_proxied_udp`): URL patterns do not govern STUN/TURN traffic, and with no proxy WebRTC gets no UDP path. It refuses to continue unless the running Chrome is version 149 or newer, which `--allowedUrlPattern` needs. It then runs the pinned `chrome-devtools-mcp` with `--allowedUrlPattern` for each declared origin, the memory (heap snapshot) tools off, usage statistics off and network headers redacted. `evaluate_script` is available for measurement only. That limit, like "view only" and "never submit", is a prompt rule, not an enforced one: the click, fill and script tools can act on a page. What is enforced is where the browser can reach. So a web task should point at pages where an interaction can do no harm, such as Storybook or a test environment.
- **Audit.** AGY has built-in tools no rule can deny (web search, messages, subagents, its own browser), so the audit runs before any other classification and fails closed:
  - a result is accepted only from a stream with exactly one `init` event in `request-review` mode;
  - every update of every step is judged, whatever its state, so a disallowed tool counts even when it started without a terminal update, and a later update cannot rename it;
  - a step type other than the four seen in AGY 1.3.3 (`user_input`, `agent_response`, `tool`, `finish`) voids the run;
  - only the browser tools listed in the prompt and AGY's own `finish` (which submits the result) are accepted. Any other tool, including the browser server's upload, heap-snapshot, extension and DevTools-comment tools, rejects the result without provider fallback, unless the step never reached `DONE` and ended in an error showing it never ran (a permission denial or a call rejected before running, matched at the start of the message);
  - the controller reads AGY's whole event log, up to 64 MiB, instead of the 4 MiB tail it keeps for other providers. A log it cannot fully audit, because it has an unreadable line or is over 64 MiB, counts as a violation: what it hides might have been one. It is never read as a quota wait.

  A disallowed tool, a tool that needed approval, or a permission mode other than `request-review` is a **boundary violation**, and a violation is never hidden behind a timeout. The task is held as a B3 owner decision, with no retry on AGY and no other provider. After review, `recheck --task <id>` releases it. Quota and login waits are read only from AGY's own error report and its `error:` lines on stderr.
- **Configuration.** `config.json` sets `commands.agy` (the native `agy.exe`, not the `.cmd` shim) and `commands.chrome` (an absolute Chrome executable). Without them the provider waits as unconfigured. A missing or older-than-149 Chrome (judged by the version folder beside `chrome.exe`), or a missing `chrome-devtools-mcp` install, makes it unavailable until a recheck. Validation also requires a provider for every task: a web task needs `agy-cli`, and any other task needs a provider other than `agy-cli`.

Probe findings behind these rules (agy 1.3.3, chrome-devtools-mcp 1.10.1, Chrome 155, workstation, 2026-10-11):
- In print mode, a tool that falls to "ask" ends the turn without output. An explicit deny returns a tool error and the session continues.
- With chrome-devtools-mcp's own Chrome launch, every browser call timed out after 3 minutes when AGY was the MCP host. The wrapper therefore owns Chrome; a Chrome it starts runs normally under the fully run-local environment. A direct check of the wrapper under that environment confirmed that an off-origin navigation is blocked, that a screenshot into the real `%TEMP%` is refused and that no heap-snapshot tool is offered.
- Escape probe against a decoy local service on another loopback port (which stands in for the dashboard at 4318 and local control service at 17321). It drove the wrapper under the run-local environment, from a page on the declared origin and from `evaluate_script`. The decoy received **no** request:
  - from `fetch` to `127.0.0.1`, `localhost`, `[::1]`, `0.0.0.0`, `127.1`, `2130706433` or `foo.localhost`;
  - from XHR, image, WebSocket, `sendBeacon`, iframe or Web Worker `fetch`;
  - from scripted `location.href` or `window.open`;
  - from `navigate_page` or `new_page` to any of those addresses.
- A WebRTC page asked for a STUN server on this PC's LAN address. With the policy flag it gathered no candidate at all.
- A headless window cannot be narrower than about 500 px, so phone checks use `emulate`.
- On a page with planted defects, a first probe found every planted defect but passed a phone-width criterion that measurement showed failing. The prompt therefore requires measured evidence and phone checks through `emulate`. Through this adapter and the contained runner, AGY then judged all eight criteria correctly (about 4.5 minutes), and a fresh AGY verifier re-measured every claim and accepted the report (about 3 minutes).

## 12. Auto Release (built, not enabled)

**In short.** No release runs. Every project and destination is **Review only**: the supervisor publishes checked results and never deploys them; it merges only under the opt-in merge gate (section 3), which is not a release ([AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception)). Auto Release ([#13](https://github.com/example-org/aiworks/issues/13), [design](design/AUTO_RELEASE.md)) is being built switched off. The owner answered [#33](https://github.com/example-org/aiworks/issues/33) on 2026-10-17 ([plan section 8](PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates) (h) to (k)): no release token, one merge path per repository, and nothing switched on before the disposable rehearsal (slice REL11). Until then this section describes all there is.

What exists in code, all inert (observed; nothing outside the tests drives a release):

- **Eligibility** (`src/supervisor/release/eligibility.mjs`) reports per done task "would be eligible" or "not eligible, because ...". It never acts.
- **Release state** (`src/supervisor/release/state.mjs`, tables `releases` and `release_locks`): one release per destination at a time, a step recorded as started before it acts, and reconciliation instead of repetition after a restart.
- **The switches**, checked before every release step ([design §4.5](design/AUTO_RELEASE.md#45-the-kill-switches)). A step may start only when all four allow it:
  1. `release.enabled` in `config.json` is exactly `true`. Absent, or any other value, is off. It is off on every install.
  2. There is no file `RELEASE-STOP` in the data directory. If the supervisor cannot tell, it stops.
  3. A valid release grant names the destination.
  4. The destination's mode is Auto Release. The mode is Review only unless that grant is newer than the owner's last narrowing.

A stop prevents the **next** step. It never interrupts a running step and never prevents recovery: after a merge, deploy or apply, the check still runs, and a rollback still runs if the check fails. A stopped release keeps its place and its destination lock; its `reason` says why.

Owner commands (both only narrow):

- `node src/supervisor/cli.mjs release-stop --data <dir>` writes `RELEASE-STOP`: **stop all releases** on this machine. It needs no database. To allow releases again, the owner deletes the file.
- `node src/supervisor/cli.mjs release-mode <project> <destination> review-only --data <dir>` narrows one destination to Review only. It needs no grant and takes effect before the next step. `review-only` is the only mode the command accepts. **No command switches a destination to Auto Release**: only a newer valid grant does.

`status` shows `release.stopped` while `RELEASE-STOP` exists and `release.narrowed` for destinations of the campaign's project that the owner narrowed. Neither appears until used.

**The disposable rehearsal** (first half of REL11, owner decision (j)). `node scripts/supervisor/release-rehearsal.mjs` (`--json` for the structured report) runs whole releases through the production release code against a synthetic project: a disposable Git repository with a grant record and four project commands, a folder standing in for a site, and a disposable data directory, all in a new temporary folder that is removed afterwards. `release.enabled: true` exists only in the rehearsal's memory; it reads no installation data, needs no `--data`, starts no service and makes no network call. The grant is read by `loadAuthorization` at a ref, eligibility is the E1 to E13 evaluator, the switches are `releaseGate`, every project command runs through the release runner in its own clean process. It checks, and prints one line per expectation:

- an exact-revision release: eligible on positive evidence, lock taken after a fresh re-check, deploy run once for the merge commit the merge gate recorded (whose tree is the verified tree), the site running that revision with the recorded digest, the previous digest retained, the lock freed;
- Check the site now (below) on that release: passed, then failed on a broken site, running only `check`, never changing the release;
- a failed post-release check: automatic rollback to the previous digest, which observe and check confirm;
- a controller killed after deploy acted and before its outcome was recorded: after a takeover the step is unknown, a read-only observe settles it, and deploy is never repeated;
- an outcome nobody can read: unknown, never success; the destination stays locked, E11 refuses the next release, and it settles only once observe can read the site;
- refusals before anything runs: `release.enabled` off, `RELEASE-STOP`, a missing, expired or revoked grant, a grant revoked between planning and the lock, a database migration, an unclassified file; a stop after the lock prevents the next step, and a merge commit holding another tree than the checked one is refused;
- Review only: a narrowing refuses every later release, and across the whole rehearsal no revision was deployed twice.

Evidence only a running installation holds is synthetic there and named as such: the governance pointer (E3), the verifier's sessions (E4), required checks (E8), dependencies (E10) and owner-reserved reports (E13). `tests/supervisor/release-rehearsal.test.mjs` runs the same rehearsal in the suite. Passing it is evidence about source, not about any destination.

**Releases and Check the site now** ([OWNER_UI_V2 WP9](design/OWNER_UI_V2.md)). Each release row now keeps, from eligibility, its destination (id, environment, kind, rollback rule, which commands it names) and where its grant was read (`ref`, `path`); a row recorded before says its restore scope is unknown. The dashboard's Releases screen (`#/p/<project>/releases`, linked from Results; `GET /api/v2/projects/<id>/releases`) shows per release the destination, the user-facing change with its change classes and file count, the checked commit, merge commit, live digest and grant version, the restore scope (the previous version through the project's rollback command, report-only, no rollback command, a revert pull request, a backup, or unknown) and the latest health (passed, failed, unknown, checking or not checked; unknown is never healthy). Checked, merged, live and accepted stay separate answers. Publish is shown not available with what is missing: a manual Publish is not built, and could only use a destination an existing valid grant names. **Check the site now** (`POST /api/v2/releases/check`, after the caller check) takes only a release id and runs `release/health.mjs`: one read-only `check` of a settled release (accepted, rolled back or rollback failed) at its deployed revision, through the release runner, only while `release.enabled` is true, `RELEASE-STOP` is absent and the grant, read again at the recorded ref and path, is valid and names the destination with a `check` command. It records the answer on the row (`health_check`, an additive column) and in the journal, and never changes the release's state or lock and never rolls back. With `release.enabled` false, as on every install, it is refused with that reason.

**Still missing before a real release** (explicit prerequisites, not done here): the governance pointer to a real grant (R11), the owner's canary grant for one destination (decision (j)), the supervisor driving releases on its own (switching on REL11), the destinations a manual Publish may reach (OWNER_UI_V2 WP9, owner's), and remote access to the dashboard (AW-003, WP10). AIWorks never releases into its own live runtime.

Project connectors accept an explicit `tenantId`. When omitted, the installation-local identity `local` is used; existing stored project identities are unchanged.

## 13. CAAM account profiles (built, not enabled)

Account-management boundaries in the code:

- Configure logins through the provider's native CLI. The dashboard displays configured accounts and usage; its account-connect and credential-pickup routes are unavailable. A generic browser login cannot establish which CLI credentials belong to an account.
- An operator-invoked portable bundle import validates every provider, plain profile name, portable relative file path and string payload before writing any profile. Absolute paths, traversal, Windows aliases/streams, duplicate or conflicting paths, symlinks/junctions and existing hard-linked files are refused. Export applies the same profile containment checks. Tests use disposable synthetic files only.
- Stored model preferences are metadata. Registered campaigns keep their declared static executor order, models and effort; auto routing keeps its authorized candidates and pins. Changing execution authority follows the existing declaration/version handover.

**In short.** AIWorks can share work between several logins of one provider, for example two Claude subscriptions, so that a usage limit on one login does not stop the work. The logins come from CAAM, the Coding Agent Account Manager. This is off on every install. Nothing in a running supervisor uses it yet (observed: `cli.mjs` gives the controller no CAAM inventory and no profile homes). Design: [ACCOUNT_ADAPTER_CAAM.md](design/ACCOUNT_ADAPTER_CAAM.md). Work item: [#9](https://github.com/example-org/aiworks/issues/9).

What the code does when the switch is on and an inventory is supplied (observed in code, verified by the synthetic tests only):

- **Reading profiles.** `src/supervisor/adapters/caam.mjs` runs `caam robot status claude` (or `codex`) and keeps each profile's name, health, cooldown and expiry. It drops the email, auth paths and any other field, and its errors never quote CAAM's output. AIWorks only reads status: it never runs `caam run`, because AIWorks alone owns retries and scheduling. Consumer AGY is excluded.
- **Choosing a profile.** Before each run, inside the same database transaction that records it, AIWorks picks the least recently used profile that CAAM lists as eligible and that has no wait or full limit of its own. Two runs in a row therefore go A, B, A, B. The choice is stored on the run (`operations.account_identity`, for example `claude/work-a`) and journalled in `operation-recorded`.
- **Limits stay with their profile.** A usage limit, failed login or host failure on profile A waits on A only and halves A's learned concurrency. The task goes back at once and the next run goes to B. When every profile waits, the task waits for the earliest reset, spends no retry and asks the owner nothing. A success on A clears A's wait only. A `recheck` clears profile waits too.
- **Launching inside the profile's home.** When the controller is also given the profile homes (`profileHomes`), a run bound to profile A starts inside A's own shallow home folder. CAAM creates that folder once (`caam shallow-profile create`). The worker's `HOME` and `USERPROFILE` (and `CODEX_HOME` for Codex) point there, so it reads A's login and never the host's own `~/.claude`. AIWorks' isolation flags stay as they are. If the folder cannot be prepared, nothing is recorded or launched: the task waits and retries later, and the host login is never used instead.
- **Restart.** After a crash the replacement supervisor reads the profile from the stored run, never from a new choice. An open run is resumed once and counted against its own profile.

**Configuration.** In the data directory's `config.json`:

```json
{ "caam": { "enabled": true }, "commands": { "caam": ["C:\\path\\to\\caam.exe"] } }
```

`commands.caam` is the path of the CAAM program only, never a credential. CAAM keeps the logins in its own vault.

**Rollback.** Set `"caam": { "enabled": false }` (or remove the key) and restart the supervisor. New runs then use the single account of each executor kind, as before (section 4, provider usage limit). They launch under the host login, with no profile home. CAAM is not called. A run still open keeps its stored profile and finishes normally. The store needs no change. Turning the switch on again resumes the rotation from the stored history.

**What is not done yet (planned):**

- Supplying the CAAM inventory and the profile homes from `cli.mjs`, choosing the shallow homes folder, and turning the switch on at an install are the owner's Phase 2 pilot ([design section 5](design/ACCOUNT_ADAPTER_CAAM.md#5-four-step-rollout-plan)). It waits for that decision and goes through the upgrade procedure (section 6).
- Compatibility with a real CAAM install is unknown. The tests use a synthetic `caam` program.

## 14. Program waves (built, not enabled)

**In short.** Nothing starts by itself yet. When this is switched on, the supervisor starts the next wave of a delivery program on its own, but only under a program record the owner approved once ([#153](https://github.com/example-org/aiworks/issues/153), [plan section 6.8d](PROJECT_WORKSPACE_PLAN.md#68d-lane-prog---the-next-wave-starts-by-itself), decision (n) of [section 8](PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates)). It is off on every install. Slice PROG5 switches it on, through the upgrade procedure (section 6).

The owner's commands (slice PROG1):

- `node src/supervisor/cli.mjs program-approve <record.json> --data <dir>` keeps the owner's private `aiworks-program/1` record by its digest. A newer `authorization.version` replaces it; `revoked: true` revokes it for good. Approving starts nothing.
- `node src/supervisor/cli.mjs program-stop --data <dir>` writes `PROGRAM-STOP`: **no new wave of any program**. It needs no database. To allow waves again, the owner deletes the file.
- `node src/supervisor/cli.mjs program-status --data <dir>` shows the switch, the stop file and the approved programs, without their contents.

What the controller does on each pass (slice PROG3; observed in code, verified by the synthetic tests only):

- **The switches.** It does nothing unless `config.json` says `"program": { "enabled": true }`. Absent, or any other value, is off: no plan is read and nothing is registered. It also does nothing while `PROGRAM-STOP` exists (or cannot be read), and nothing while the running code is not merged into origin/main (AW-005).
- **When.** Each approved, unrevoked program is checked at most once an hour. The check times are kept in memory: after a restart each program is checked once more.
- **One wave at a time.** While a wave campaign of the program (`<programId>-w<n>`) has a task that is not done, no next wave is registered. A cancelled wave does not hold the next one.
- **The plan comes from main.** The supervisor fetches the base branch into its own ref, as the merge gate does, and reads the plan file there. It never writes the checkout.
- **The wave.** The ready slices become one declaration by fixed rules (`src/supervisor/program-plan.mjs`). The project, environment and tracking issue come from the newest campaign the owner registered for the same repository and base branch.
- **Registration.** The wave is registered only if every task fits the record exactly (the record's repository, base branch, authorization, executor and constraints, unchanged; every slice allowed and not excluded) and its target is a registered project, the same check as `start`. It goes through the same `campaignStart` as `start`. The wave row (table `program_waves`), the campaign and the journal event `program-registered` are written in one transaction. The event carries the record digest and the declaration digest. A crash between them leaves none of them, so a wave number is never registered twice.
- **A misfit.** A wave that does not fit, or that `campaignStart` refuses, registers nothing. It becomes one owner item (a B3 record in table `blockers`, one per program) with the reason. The proposed declaration is in the journal event `program-misfit`. A later registered wave resolves the item.

**Rollback.** Remove `program` from `config.json` (or set `enabled` to `false`) and restart the supervisor, or write `PROGRAM-STOP`, which needs no restart. Waves already registered are ordinary campaigns: pause or cancel them as usual.

**What is not done yet (planned):**

- The dashboard lists owner items per campaign only, so the misfit item is not yet shown under Needs you (unknown which slice adds it); it is in the store and the journal.
- PROG4 records the decision text. PROG5 approves the owner's first record and switches `program.enabled` on.

## 15. Cleanup after finished work (built, not enabled)

**In short.** Nothing is cleaned yet. When this is switched on, finished tasks leave no worktrees and no merged local branches behind, and nothing unsaved is lost ([plan section 6.8c](PROJECT_WORKSPACE_PLAN.md#68c-lane-cln---cleanup-after-finished-work), decision (l) of [section 8](PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates)). It is off on every install. Slice CLN2 records a private baseline and switches it on, through the upgrade procedure ([section 6, Local operation](#local-operation-rehearsal-switch-on-and-switch-back)).

What the controller does on each pass (slice CLN1). Code: `src/supervisor/cleanup.mjs`. The critical regressions in `tests/supervisor/cleanup.test.mjs`, including a finished worktree that holds ignored evidence, are restored for activation. Passing synthetic checks does not claim that an installation has enabled cleanup.

- **The switch.** It does nothing unless `config.json` says `"cleanup": { "enabled": true }`. Absent, malformed or any other value is off. Optional `cleanup.repositories` limits cleanup to the listed repository names, compared case-insensitively; an empty list cleans nothing, and a malformed list keeps cleanup off. Without the list, all registered repositories remain eligible. With the list, shared coordinator checkouts are preserved because they have no repository scope. It also does nothing while the running code is not merged into the trusted main (AW-005). It runs at most once per `integrationPollMs`.
- **Finished.** A task is finished when no operation of it is recorded or dispatched, no other supervisor instance holds its campaign's lease, and either the trusted main (`origin/main` as the supervisor fetches it into its own ref, or the trusted tip of local main when self-hosted) contains its verified commit, or its campaign is finished or cancelled. A coordinator or planning checkout is finished when none of the coordinator runs that used it is open; while the coordinator lane is blocked by a boundary violation, its checkouts are not touched.
- **Owned.** A task owns the workspaces its operations recorded; the coordinator lane owns the checkouts its runs recorded. A registered worktree inside the folder that nobody owns is kept and journaled `cleanup-kept` (`unowned`).
- **Worktrees.** Only a registered worktree inside its registered folder (the repository's `worktreeRoot`, or the coordinator's), after links are resolved, is removed, with `git worktree remove`, never `--force`. One with uncommitted or untracked files, ignored files (git would delete them with the checkout, so private run notes under an ignored `.local/` or any unknown ignored file keep it; only an installed `node_modules` directory and the gate files below may go), a lock, an unreadable status, or a detached commit that no branch or remote ref holds is kept and reported. The verifier's gate files at the checkout's root are first copied into the owning run directory (`worktree-<checkout>-gate.log` and the like); a checkout whose gate files cannot be copied is kept.
- **Branches.** A finished task's local `campaign/<campaign>/<task>` branch is deleted with `git branch -d`, never `-D`, and only when the trusted main contains its tip and no worktree has it checked out. A branch the trusted main does not contain is kept and reported (`not-in-main`). Remote branches, run directories and the store are never deleted, and nothing is deleted recursively.
- **Crash safety.** Each removal is journaled `cleanup-started` before and `cleanup-finished` after. After a restart, a removal journaled as started but never finished is settled once from what git shows (`reconciled: true`): done, or `interrupted`, in which case the next pass decides again from its own checks. A crash between a worktree's removal and its branch's deletion therefore finishes once.
- **Repair afterwards.** A task reopened later (integration or CI repair) gets its worktree recreated by dispatch at the published verified head, as for any missing worktree.

**Rollback.** Remove `cleanup` from `config.json` (or set `enabled` to `false`) and restart the supervisor. Nothing removed comes back by itself; a repair round recreates the worktrees it needs.

**What is not done yet (planned):** CLN2 records the baseline, switches `cleanup.enabled` on and compares after the first passes. Worktrees that no run recorded, such as merge refresh checkouts, are only listed.

## 16. External campaign API (off by default)

**In short.** An external system on this computer — a change-request tracker that assembles campaign declarations
itself, for example — can register a campaign and read its status over HTTP instead of running `cli.mjs` as a local
process: `POST /api/campaigns` and `GET /api/campaigns/:id/status` on the dashboard's own HTTP server
([OPERATIONS_DASHBOARD.md](OPERATIONS_DASHBOARD.md), `http://127.0.0.1:4318`). It is additive: the CLI and the owner's
browser dashboard work exactly as before, and this surface widens nothing either can already do. Code:
`src/supervisor/remote-campaigns.mjs` and `src/supervisor/token-store.mjs`, wired into `src/dashboard/server.mjs`.
Critical-behaviour tests: `tests/dashboard/campaign-api.test.mjs` and `tests/supervisor/token-store.test.mjs`.

**Why the dashboard's own server, and why a status poll rather than an outgoing webhook.** The dashboard already is the
one process that listens on a local port and reads the store; adding two routes to it needs no new service, no new
port and no new process to supervise or restart. Posting status to a URL the campaign declaration names would instead
make the supervisor's own process open outbound connections chosen by whoever can submit a declaration — a new kind of
external write the existing boundary does not have (section 1: "the only writes outside this repository are
worktrees, branches, pull requests and issue comments, for work the owner registered"; a webhook destination is none
of those) — and it would need its own delivery, retry and signing story that a poll does not. A status poll fits the
architecture's own stated shape instead: "No route calls GitHub" and nothing here is pushed; a caller reads
`/api/campaigns/:id/status` as often as it wants, exactly as the dashboard itself re-reads `/api/state`.

**Fit with [AW-003](DECISIONS.md#aw-003---the-operations-dashboard-is-local-only).** AW-003 binds the dashboard to
loopback and requires exact origin checks and CSRF protection for mutating requests, and says remote access needs a
separately reviewed authentication design. This stays bound to `127.0.0.1` exactly as before: nothing here is remote,
only a second local process. Its two routes are exempt from the origin/CSRF check — a static bearer token resolved
from the operator's own secret store in its place — because their caller is by design not a browser holding the
dashboard's session, so CSRF protection (which defends a browser session against another page's script) does not
apply to it; this is the separately reviewed authentication design AW-003 anticipates for a caller that is not that
browser session. The exemption is narrow: it exists only while the switch below is on, it covers exactly
`POST /api/campaigns` and `GET /api/campaigns/:id/status`, and such a request is answered by those two handlers in full,
so it never reaches another route. A browser page cannot send the token across origins (the server gives no CORS
answer), and a page that rebinds a name to `127.0.0.1` does not hold it. Every other route keeps its Host, Origin,
CSRF and caller checks unchanged.

- **The switch.** `config.json` `"campaignApi": { "enabled": true, "tokenRef": "<name>", "credentialStore"?: { "kind":
  "windows" } | { "kind": "command", "command": [...] } }`. Absent, malformed, `enabled` not exactly `true`, or an
  invalid `tokenRef` or store (`token-store.mjs` `validTokenRef`: short segments joined by `/` or `:`) all leave it off:
  both requests then meet the dashboard's own gates exactly as before the API existed (`403` from another Host or
  origin or without the session's CSRF token, `404` for the status path), whatever the store holds. Without
  `credentialStore` the Windows Credential Manager is used.
- **The token is a reference, never a value.** `config.json` holds the `tokenRef`, never the token (AGENTS.md:
  "configuration holds executable paths and repository paths, never secret values"). Its value lives in the same kind
  of operator-managed secret store the release credential uses, through its own module (`token-store.mjs`; the release
  credential's `release/credential.mjs` is not involved): the Windows Credential Manager by default, or an operator's
  credential helper command. It is resolved fresh on every request that carries a bearer token, never cached, logged
  or journalled; a store that cannot tell whether the reference resolves is treated as refused, never as open access.
- **Authentication is a header, never a query parameter.** `Authorization: Bearer <token>`, compared to the resolved
  value by comparing fixed-length SHA-256 digests in constant time. A missing or wrong token answers `401`; a token in
  the query string is ignored. This token is never the dashboard's
  own per-process CSRF secret that a browser session reads from `GET /api/session` (server.mjs): the two surfaces share
  no secret, so a token good for one never reaches a route of the other.
- **`POST /api/campaigns`** accepts exactly the JSON a private declaration file holds — the same contract
  `src/supervisor/campaign.mjs` `validateDeclaration` checks, the same examples under `tests/fixtures/campaigns/` — up
  to the same 1 MiB a file may be. It does exactly what `cli.mjs start <file>` does with no `--approval`, in order:
  the AW-005 merged-code check against the same trusted main `start` uses (section 1, "Merged runtime code", including
  `selfHosting` local trust); for a campaign id not yet stored, the registered-project gate
  (section 1, "Registered targets only"); then registration, amendment or resume
  (`approvals.mjs` `approvedStart`, honouring `config.json` `"approvals": { "required": true }` exactly as a plain
  `start` would). A resend of the exact declaration already registered is never refused, exactly as `start` never
  refuses one: the response is `200` with `created: false` in place of `201` and `created: true`, and nothing is
  registered twice. The response body otherwise is the same reading `cli.mjs status` prints (`campaignStatus` below).
  A refusal names its code and message the same way the CLI does (`RUNTIME_NOT_MERGED`, `WORK_ALREADY_ASSIGNED`,
  `SCOPE_CONFLICT`, a declaration validation message, and so on), at the HTTP status that best fits it: `503` for an
  operator-side condition (unmerged runtime, a missing governance checkout), `403` for a target this installation has
  not registered, `409` for a conflict with existing work, `400` otherwise.
- **`GET /api/campaigns/:id/status`** answers exactly the reading `cli.mjs status <id>` prints (`api.mjs`
  `campaignStatus`): phase, readiness, tasks, budget, CI and release status, never worker output or a local path. An
  unregistered id answers `404` with `code: "CAMPAIGN_NOT_FOUND"`.
- **A project's token reaches that project only.** When `tokenRef` is a project's standard reference
  `aiworks-campaign-api:<projectId>` (below), registration needs a declaration whose `target.repository` is that
  project's `repository.github` in the governance checkout, and refuses (`403`, `TOKEN_OUT_OF_SCOPE`) a declaration for
  another repository or one that would amend another project's stored campaign; a status read of another project's
  campaign answers `404` exactly like an unregistered id. A `tokenRef` of any other shape reaches what `start` and
  `status` reach.
- **Never a replacement for the CLI or the dashboard.** Pause, cancel, recheck, instructions and every owner-facing
  control stay on the existing CLI commands and the browser dashboard, unchanged. This surface only starts a campaign
  and reads its status, exactly as `start` and `status` already do locally.

**Managing the token (`campaign-token`, `src/supervisor/campaign-token.mjs`).** Turning this surface on for any
AIWorks-registered project is one general CLI action, not a one-off done by hand for a single external project:

```
node src/supervisor/cli.mjs campaign-token create <projectId>
node src/supervisor/cli.mjs campaign-token rotate <projectId>     # replace an existing token
```

`<projectId>` must be a project this installation already knows: `registry/projects/<projectId>.json` must exist in
the governance checkout, the same registration a new campaign already needs
(`campaign.mjs` `assertRegisteredTarget`). `create` generates a fresh random value
(`crypto.randomBytes(32).toString('base64url')`, 256 bits) and writes it over stdin to the operator's credential store
(`token-store.mjs`: the Windows Credential Manager by default) under the one
standard reference `aiworks-campaign-api:<projectId>` -- never a name the caller invents, so the store's own listing
already says which project a token belongs to. It then points `config.json` `campaignApi` at that reference:
`{ enabled: true, tokenRef: "aiworks-campaign-api:<projectId>" }`, keeping every other setting; a `config.json` that is
not a JSON object refuses (`CONFIG_INVALID`) before anything is written. `create` refuses to overwrite a value already
stored there (`TOKEN_ALREADY_EXISTS`: run `rotate` instead); `rotate` refuses when nothing is there yet to replace
(`TOKEN_NOT_FOUND`: run `create` first). Either command prints only the fact that a token now exists and the
reference it lives under -- **never the token value itself**, in any form, on any stream: an operator reads the value
back from the credential store (Windows Credential Manager, `cmdkey`, or a configured credential helper command)
only at the moment an external caller needs to be given it. Only one token is active at a time per installation
(`config.json` `campaignApi` names one reference), so pointing it at a different project's token is itself a `create`
or `rotate` for that project id. Critical-behaviour tests: `tests/supervisor/campaign-token.test.mjs`.
