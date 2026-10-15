# AIWorks delivery supervisor

Work-state authority: [example-org/aiworks#2](https://github.com/example-org/aiworks/issues/2). This runbook covers slice A: a durable store, one explicit campaign, controller lease and fencing, one bounded headless worker, an independent verifier, and restart recovery. Slices B (GitHub webhooks plus owner-notification recovery, [example-org/aiworks#1](https://github.com/example-org/aiworks/issues/1)), C (project release adapter) and D (install evidence and canary on an approved host) remain open.

The supervisor applies the portfolio [CONTINUATION.md](https://github.com/example-org/governance/blob/main/docs/CONTINUATION.md) contract and this repository's [WORKER_CONTEXT_LIFECYCLE.md](WORKER_CONTEXT_LIFECYCLE.md). It does not redefine them. It reuses the C0 helpers in `scripts/lib/worker-context.mjs` (`validatePacket`, `packetDigest`, `planContext`, `acceptsLease`) and keeps no second packet or lease model.

governance provider's governance files (project registry, policies, project-contract schema) are read from the governance checkout described in [section 6](#governance-checkout).

## 1. Boundary

- It runs only campaigns the owner explicitly registered. A campaign declaration names the authorization, target repository, tasks and DAG, limits and executor. It never claims unassigned backlog.
- **Merged runtime code, private declarations (AW-005).** Runtime HEAD must be an ancestor of `origin/main`. This check uses git on PATH, cannot be disabled and never fetches or changes a ref. Missing or unmerged code stops new execution and coordinator dispatch; already-running operations finish and their results are recorded.
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
  - **Optional `writes` (write domain, #5 scope B).** A commit task may list the part of the repository it may change: path prefixes (`"src/dashboard/"`, `"docs/SUPERVISOR.md"`) and named exclusive resources (`"resource:port-4319"`). An entry covers itself and everything below it, never a sibling that only starts with the same letters (`docs/A.md` does not cover `docs/A.md.bak`). Without `writes` the task owns the whole repository. The worker and its verifier are told the domain in the packet constraints. The list is checked, not trusted: a commit that changes a path outside it is a **boundary violation**, held for the owner and never retried on another provider (paths compared case-folded; an integration repair is measured from the base it merged). Like `workKey` it is part of the scope digest, and a declaration without it keeps its digests. Who holds a domain is derived from existing rows (`domainHolders` in `src/supervisor/work-ownership.mjs`): an open implement operation (in any campaign, until it is settled), a task implemented, verifying or verified, and a published commit until it is in the base (in finished and cancelled campaigns too). Admission by domain belongs to the scheduler (section 7, built and off by default); while it is off, campaigns run as before.
  - **Optional model routing fields ([MODEL_ROUTING](design/MODEL_ROUTING.md), slice R3). They are checked, but nothing uses them yet:** every step still runs on the declared executor order, as before. Routing by these fields is slice R5.
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
- **A reference may name one section ([SCOPED_READING §3](design/SCOPED_READING.md#3-the-reference-grammar), slice READ1).** **Do not write anchors into a declaration yet.** Until slice READ2 is deployed, nothing gives an anchor a meaning: the worker is told to read the path, and the literal `#` makes that read fail. Write anchors into a private declaration only when READ1 and READ2 are both deployed; merged is not deployed.
  - **Grammar.** A task reference is a repository path (the whole document, as before) or `path#anchor` (one section of a Markdown document), for example `docs/SUPERVISOR.md#3-lifecycle-of-one-task`. The anchor is the slug GitHub renders for the heading: 1 to 160 of `a-z`, `0-9`, `_` and `-`, after exactly one `#`. Two sections of one document are two entries; each counts toward the 24.
  - **Refused.** A reference with two `#`, an empty anchor or another character in it is refused at `start`, and in a child amendment with `INVALID_TASK`. A path that itself holds a `#` can no longer be referenced. A secret-like path is refused with or without an anchor (`docs/.env#x`, `secrets.md#y`): in a version 2 declaration and in a child amendment as `WIDEN_CAPABILITY`, in a version 1 declaration when it carries an anchor.
  - **Digests.** The anchor is part of `scopeDigest`, like the rest of the reference. A declaration without anchors keeps its `scopeDigest` and `authorityDigest`. Code older than READ1 accepts an anchored reference without checking the anchor.
  - The resolver (`src/supervisor/reading.mjs`) finds a section's lines from its heading; nothing calls it yet.
- **Version 2: one approved envelope ([WORK_ENVELOPE §4](design/WORK_ENVELOPE.md#4-the-approval-envelope), slice E2).** A declaration may be `"version": 2` with an `envelope` block: the approved outcome and the boundary every task stays inside. Version 1 declarations are unchanged: `envelope` is still an unknown key there, and every committed declaration keeps its `scopeDigest` and `authorityDigest`. A version 2 declaration registers through the same `start`, with every version 1 rule and gate. Nothing adds tasks to it yet: child tasks are slice E3 (STA8).
  - **Fields.** `outcome` (1 to 300 characters); `acceptance` (1 to 16 checks); `writes` (0 to 32 path prefixes or `resource:<name>` entries, none secret-like; empty means report-only work); optional `denyWrites` (prefixes inside `writes`); `deliverables` (`commit`, `report` or both); `issues` (issue numbers, may be empty); `web` (today's `web` rules, or `null`); `release: { mode }`; `planning` (`adaptive` or `fixed`); `scopeVersion` (1, or N + 1 with `supersedes: { campaignId, scopeDigest }` of another campaign); `request: { route, reference, pinned }`. The route is `goal`, `issue`, `pr` or `plan-file`. `pinned.base` is a commit id. An issue also pins `issueUpdatedAt`, a PR `headSha`, a plan file `path` and `blob`. Unknown keys are refused.
  - **Review only.** `release.mode` accepts only `review-only`. `auto-release` is refused with `RELEASE_MODE_UNAVAILABLE` until the owner decides [#33](https://github.com/example-org/aiworks/issues/33) (plan resolution C10).
  - **The approved tasks stay inside the envelope**, with the refusal code in the message: a commit task must declare `writes`, each inside `envelope.writes` and not overlapping `denyWrites` in either direction (`WIDEN_FILES`; paths compared with `\` as `/`, no trailing `/`, case folded); its deliverable is in `deliverables`, its references are not secret-like and its `web` pages and resource origins are within `envelope.web` (`WIDEN_CAPABILITY`); its issue is in `issues` (`WIDEN_DESTINATION`). Campaign, task and the one envelope constraint fit in 24. The task ids `ACCEPT` and `PLAN` are reserved.
  - **Still GitHub only.** `target.trackingIssue` and task `issue` stay required for now: the controller posts reports and blockers to them. A local target (`target.source`) or an `aiworks-local:` authorization is refused with `LOCAL_START_OFF` until the owner decides [#24](https://github.com/example-org/aiworks/issues/24) and [#32](https://github.com/example-org/aiworks/issues/32).
  - The envelope is part of `scopeDigest`, so a registered campaign's envelope cannot change (`SCOPE_CONFLICT`); a wider scope is a new campaign. Code older than this change refuses a version 2 declaration.
- In the target repository it may create worktrees and `campaign/<campaign>/<task>` branches, push a verified commit to that branch, open a PR, and post issue comments ([AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception)). It never deploys, releases, removes worktrees or deletes branches. It merges only under the merge gate (section 3, "Merge gate"), in a repository the owner opted in; otherwise merge and release follow the project's own gate.
  - Git cannot hold both a `campaign/<campaign>` branch and `campaign/<campaign>/<task>` branches. A declaration branch named `campaign/<campaign>` in the target repository makes every dispatch fail with "cannot lock ref", so declaration branches are named `declare/<campaign>`.
- Workers use only the executor or ordered CLI chain authorized by their private declaration. Usage/rate limits and exhausted credits or billing limits move to the next eligible provider; when every eligible provider is waiting, the campaign waits for the earliest reset and continues. Each attempt is a fresh, separately recorded and charged operation; the runner contains its process tree before accepting output or trying another provider. Permission denials never cause fallback. The CLI controls and remaining platform limits are described in section 8.
- **Web acceptance tasks** run only on a browser worker, AGY (`agy-cli`) or Claude given the same isolated browser; AGY runs nothing else (section 11).
- Wiki's native workers are restricted to the brokered research mode described below; their terminal envelopes must bind the exact fresh run nonce and packet digest, and unknown usage/cost stays unknown.
- No GitHub Actions, no new paid service, no Telegram workflow of its own (owner notification belongs to the owner-intervention core, section 10, [example-org/aiworks#1](https://github.com/example-org/aiworks/issues/1)). Blockers and status are written to the store and posted on the campaign's tracking issue.

## 2. State and ownership

| Concern | Owner |
| --- | --- |
| Campaign scope, assignment, findings, published status | GitHub issues/PRs; the declaration file in `campaigns/` |
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
exceeds the limit. Completion guidance names the actual target and
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

Verification runs on this computer (Windows), but the repository's CI may run elsewhere: AIWorks's own CI runs on `ubuntu-latest`. A PR can pass verification and still fail CI ([#42](https://github.com/example-org/aiworks/issues/42)). With CI repair on, the supervisor reads the CI result of every published head and sends a failure back for repair.

- **Off by default.** With no `ciRepair` block in the data directory's `config.json`, the supervisor never reads CI and a published PR stays as it is. Turn it on with `"ciRepair": { "enabled": true }`. Like any runtime change, that goes through the upgrade procedure (section 6). Status shows CI as `unknown` while it is off.
- **Reading CI.** After publication, the supervisor reads the PR head's check runs through REST: `GET repos/{repo}/commits/{sha}/check-runs` (one page of 100). It reads each published commit task at most once per `ciPollMs` (one minute), only until CI completes, then stops. Finished campaigns are read too. After a restart a head whose CI is not settled yet is read once more. A rate-limit refusal waits for the reported reset.
- **What counts.** CI has passed only when every check run completed as success, neutral or skipped. It has failed when every run completed and one failed, timed out or could not start. Any other completed result (for example cancelled) is `inconclusive`. A head with no check run 30 minutes (`ciNoChecksMs`) after publication is recorded as having no CI. Neither counts as a pass. The journal records `ci-pending` once, then one of `ci-passed`, `ci-failed`, `ci-inconclusive` or `ci-none`, with the check names.
- **On a failure** the supervisor first checks that the task's PR is still open at that head. If it is not (merged, closed, or pushed by someone else), it records `ci-failed` with `repair: false` and does nothing else. Otherwise the task reopens as a repair round and a finished campaign becomes active again. The repair packet carries the failing check names, conclusions and links as a blocking finding: fix the cause on this branch, guard platform-specific behaviour, never weaken or skip a test, run the gate, commit. It counts against `maxRepairRounds`; past the bound the task stalls instead. The tracking issue gets a note.
- **Checks on the repair** are those of the integration repair. The new head must contain the earlier verified head. A fresh verifier checks the exact new head.
- **Publication** is that of the integration repair: the same branch and PR, a plain fast-forward push, never a force-push, never a new PR. It posts the fresh verification as a marked comment and records `ci-repaired`. Then CI of the new head is read in turn.
- **Status.** `status` carries `ci` per task (`state`, `sha`, `checkedAt`, `checks`) for every published commit task, and a campaign-level `ci`. It reads only the journal, never GitHub. The state is `unknown` (never read), `pending`, `success`, `failure`, `inconclusive` or `none`. The campaign-level `ci` is `success` only when every published head passed, and `failure` when any failed. A published step is never shown as passed while its CI is red or unknown. With CI repair on, the publication note on the tracking issue says CI is not known yet.
- **Known limits.** The repair packet names the failing checks, not the failing tests inside them; the worker reads the check output. A head with more than 100 check runs is `inconclusive`. Showing `ci` on the dashboard belongs to lane UI.

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

  Keep `decision`: without it the dashboard does not treat merging as delegated and lists verified PRs in **Needs me**. Like any runtime change, turning it on goes through the upgrade procedure (section 6).
- **The gate.** Every condition must hold. Each repository is checked at most once per `integrationPollMs` (one minute), after a fresh fetch of its base:
  1. the repository is listed and the PR is not in `merges.held`;
  2. the PR is the one this campaign task opened, on its `campaign/<campaign>/<task>` branch, still open, against the declared base branch, and its head is the task's verified SHA;
  3. the verified SHA contains the current `origin/<base>`, so the merge result is the verified tree;
  4. with `ciRepair` on, CI at the verified head passed, or the repository runs no CI on it. A head whose CI is unread, pending, inconclusive or failed waits; a failed one is reopened by CI repair first. With `ciRepair` off the gate does not read CI, so turn it on with the merge gate;
  5. GitHub reports it mergeable;
  6. the campaign is neither paused nor cancelled, and this supervisor code passes the AW-005 merged-code check.

  A PR that fails a condition waits. The journal records `merge-waiting` with the reason each time the reason changes.
- **When the base has moved** (condition 3 fails), the supervisor does not merge. It reopens the task as an integration repair round on the same branch and PR (section 3, "Integration repair of a published PR"), even with `integrationRepair` off. The journal records `merge-base-moved`. The round merges the base in, a fresh independent verifier checks the exact new head, and the repaired head is pushed to the same PR. Only then can the PR merge. This also catches a semantic conflict that merges cleanly as text. It counts against `maxRepairRounds`.
- **The merge.** `PUT repos/{repo}/pulls/{n}/merge` with `merge_method=merge` and `sha=<verified SHA>`, so GitHub refuses if the head moved. Never a squash, a rebase, a force-push, an admin bypass or a branch deletion. At most one PR per repository per pass; the next is judged against the refreshed base.
- **Crash safety.** The journal records `merge-requested` before the call, then `merged` with the merge commit, or `merge-refused` with GitHub's answer. Every attempt starts by reading the PR (`GET repos/{repo}/pulls/{n}`): a PR already merged at the verified head is recorded as `merged` (`reconciled: true`) without a second call. A recorded merge is never read or attempted again, after a restart too. The tracking issue gets a note that says merged is not deployed.
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
| Worker returns `blocked-owner-reserved` | B3 on that task only. Independent tasks continue. Only `recheck --task <id>` clears it. |
| No progress | A task whose fresh sessions return `evidence-unavailable` four times (at least ~42 minutes apart, given the backoff) stops with a B3 owner decision naming the last reason, whatever the retry limit. The same applies to a failure that repeats identically (aiworks#136). Suppose four fresh sessions in a row end in the same non-provider failure class (`error`, `invalid-result`, `exit-without-result`, `timeout`, `spawn-failed` or `lost`) with the same detail. The task then stops with one B3 owner decision named `no progress: 4 identical <class> failures; last: <detail>`, and it is not retried again. A different class or detail, or an `evidence-unavailable` result, starts that count again. A run refunded because no task attempt took place leaves the count unchanged. Provider waits and provider limits (`quota`, `auth`, `unavailable`) keep their own handling. These are no-progress guards, not spend caps: worker-run limits stay the owner's choice. A resolved or accepted result resets both counts; `recheck --task <id>` clears the block and the counts. Workers must report authorization-scope or owner-decision blockers as `blocked-owner-reserved`, which stops at once. |
| Worker-run cap or cost ceiling reached | B3 budget decision. **By default a campaign has no budget limits.** Every key in `limits` is optional, and an omitted or `null` limit means no limit; the whole `limits` object may be left out. `slots` defaults to 1; it may be declared 1..8 or `"auto"`, which takes effect only when the scheduler (section 7) is enabled. It is off by default, so every campaign runs one operation at a time. With no limits, the only stop is the providers' own subscription or usage limits, which the campaign waits out. A failing task keeps retrying with the 2/10/30-minute backoff, and a rejected deliverable keeps getting repair rounds. A budget exists only when the owner declares one: `maxWorkerRuns` (1..100), `maxRepairRounds` (0..5), `maxRetriesPerTask` (0..5) and `maxCostUsd` bind when set. An amendment that raises or removes a limit releases the stalls that only that limit caused (`stall-released`); owner-reserved and admission stalls are never released this way. An optional `limits.maxCostUsd` adds a dollar ceiling: measured provider cost plus `limits.unknownRunCostUsd` (required with the ceiling, never zero) for every counted run whose provider reported no cost. `status.budget` shows the charged total. A start with `authorization.version + 1` and higher limits resumes without losing work. The amendment also recounts runs from the stored operations: every recorded run counts except an admission-blocked one, a refusal that did no work, and an unavailable executor. The recount is idempotent, so a count corrected earlier is never reduced twice. The journal records `runs-recounted` when the number changes. |
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

Run these from the runtime checkout, `C:/example/aiworks/.local/runtime` on workstation. `start` reads a private local declaration, kept in the ignored `campaigns/` or `.local/campaigns/` folder or outside the checkout, and refuses runtime code that is not merged into origin/main with `RUNTIME_NOT_MERGED` (section 1).

```sh
node src/supervisor/cli.mjs start campaigns/<campaign>.json --data C:/example/aiworks/.local/supervisor
node src/supervisor/cli.mjs status <campaign> --data C:/example/aiworks/.local/supervisor
node src/supervisor/cli.mjs pause <campaign> "reason" --data C:/example/aiworks/.local/supervisor
node src/supervisor/cli.mjs cancel <campaign> "reason" --data C:/example/aiworks/.local/supervisor
node src/supervisor/cli.mjs recheck <campaign> --task <task> "note" --data C:/example/aiworks/.local/supervisor
node src/supervisor/cli.mjs stop --data C:/example/aiworks/.local/supervisor
```

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
paused/terminal control states retain their own readiness. `lastProgressAt` excludes lease
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
- The model is not stored on an operation yet. It is inferred from the declaration and its `executor-amended` journal entries; a provider without a declared model shows `cli-default (unknown)`.
- What it cannot measure is listed in the report (`cannotMeasure`).

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

AIWorks never writes to the governance checkout. The operator updates it by pulling governance provider's main; `scripts/supervisor/deploy.ps1` does this on every deploy (fast-forward only, refusing local changes). A registry change takes effect for new registrations and dispatches once pulled. The dashboard reads release authorizations once at start, so restart it to pick up such a change.

### Upgrade

The live runtime changes only through this procedure. The supervisor never upgrades itself. Only one session restarts the runtime at a time.

1. **Baseline.** Run `status` for every campaign that is not finished, from `.local/runtime` with the live data directory, and keep the output.
2. **Pause.** Pause each of those campaigns. A worker already running finishes and its result is recorded, but nothing new is dispatched or published. Wait until no operation is open. A paused campaign without a blocker then shows `nextAction` "Paused by the owner; start the campaign again to resume."
3. **Choose the commit.** Fetch, then take the hash from `git rev-parse origin/main`. Never type a hash by hand. The commit must be merged to main, and a change to `src/supervisor` must have an independent review approving that exact commit.
4. **Deploy.** Run `powershell -NoProfile -File scripts/supervisor/deploy.ps1 -Sha <hash>`. It disables both tasks, so their 5-minute trigger cannot start anything from a half-updated runtime. A task that does not exist is skipped. If disabling fails for any other reason, such as access denied, the deploy stops there with `deploy stopped: could not disable task …`, before it writes `STOP` or stops anything; a `STOP` left by an earlier failed deploy stays. Then it writes `STOP` and waits until the old processes are gone, stops both tasks, points `.local/runtime` at exactly that commit (detached) and runs `npm ci`, and fast-forwards the governance checkout. Last, it removes `STOP`, enables both tasks and starts `AIWorks Supervisor` and `AIWorks Dashboard` again. It stops at the first failure. Because it stops the supervisor before the checkout, a bad hash leaves it down until fixed: the tasks stay disabled, `STOP` stays, and `status` reports the supervisor stopped. Run `deploy.ps1` again once the cause is fixed.
5. **Resume.** Run the deployed runtime CLI with each campaign's identical private declaration, using the same data directory. Canonical scope, authorization version, tasks and progress must match the baseline. No declaration is copied into public source or required on main.
6. **Compare.** Run `status` again. Compared with the baseline, only the controller revision and lease generation should change.

**Applying new task definitions.** `deploy.ps1` changes the code the tasks run, not the tasks themselves. When a deployed commit changes `install-windows-task.ps1` or `install-dashboard-task.ps1`, rerun both from the runtime after step 4, while the campaigns are still paused: `powershell -NoProfile -File .local/runtime/scripts/supervisor/install-windows-task.ps1 -Checkout C:/example/aiworks/.local/runtime -DataDir C:/example/aiworks/.local/supervisor`, then `install-dashboard-task.ps1` with the same arguments. Each replaces its task's definition and starts it. Check the result with `(Get-ScheduledTask -TaskName 'AIWorks Supervisor').Triggers`: it should list the logon trigger and the 5-minute repetition. Then continue with step 5.

The old version and the journal stay in place for recovery.

Campaign ids used before the split from governance provider must not be registered again. Their reports and comments on GitHub carry the earlier comment marker, which the AIWorks supervisor does not look for, so it would post them a second time.

Relocation is an operator maintenance action, not worker cleanup: pause admissions, drain open operations, stop the supervisor and dashboard, and verify the old processes are gone. Move registered worktrees with `git worktree move`, preserving HEADs and dirty files. Update repository configuration and the SQLite operation `workspace`/`run_dir` addresses, then move the closed state directory and update the scheduled-task action and dashboard launcher. Preserve declarations, task outcomes, scope/packet digests, authorization versions, budgets, retry timers and historical prompt/spec contents; paths inside historical text remain evidence of the original run. Resume only campaigns that were registered before maintenance. Verify Git worktree registrations, database integrity, artifact existence, service paths and dashboard connectivity before considering the move complete.

## 7. Evidence and remaining gates

`tests/supervisor/` cover the following with synthetic `claude`/`gh` executables and disposable git repositories:
- validation and immutable scope;
- `BOOTSTRAP_REQUIRED` versus `ACTIVE`;
- lease fencing;
- the serial DAG, repair rounds, retry/stall, auth, budget, owner-reserved, stale target, pause and cancel cases;
- real-process crash rehearsals: after checkpoint, after launch, during the worker, whole-tree loss, between push and PR, after a report post, and two concurrent controllers;
- the owner-intervention core (section 10), including a restart during a recheck probe run.
- the CAAM account profiles (section 13): two profiles running at once, each inside its own home folder and login while the host home stays untouched, a home that cannot be prepared, rotation, a usage limit moving a task to another profile with one commit and one PR, a restart with a run still open, a secret scan of the database, run files and log, and the `"caam": { "enabled": false }` rollback (`tests/supervisor/caam-integration.test.mjs`).

They make no model, network or GitHub calls. They read governance files from a small fixture governance checkout under `tests/fixtures/governance/`, never from a real governance provider checkout.

**The test runner.** `npm test` (`scripts/run-tests.mjs`) runs the test files in three tiers ([#102](https://github.com/netbka/aiworks/issues/102)): *unit* files (pure logic, no process) 4 at a time first; then, side by side, *service* files (a dashboard server, the review fixture, git in disposable repositories) 4 at a time and *rehearsal* files (supervisor controllers, contained worker runs, the CLI, containment) 2 at a time, slowest first. A file is a rehearsal when it uses the process-starting exports of `tests/supervisor/helpers.mjs` or a `*-harness.mjs`, a fault, a fixture executable or containment. A file that starts any other child process, such as git or a synthetic executable, is a service file; only a file that starts none is a unit. Each rehearsal file takes its own temporary and data directories and ports the OS assigns, so two files never share state. Each file runs in its own process; its output appears whole when it ends, and a table of every file's time, slowest first, comes before the summary. `npm run test:quick` (`--tiers unit,service`) leaves the rehearsals out for a fast local pass; it is not the gate. `AIWORKS_HEAVY_CONCURRENCY=1` runs the rehearsals one at a time in the order before #102; `AIWORKS_TEST_CONCURRENCY` sets the other two tiers. The last summary block, after `# all test files`, is the total of every file. The crash/restart rehearsal is three files (`restart`, `restart-publish`, `restart-parallel`) over one harness, and the owner-intervention and no-limits tests two files each, so the longest cases run side by side.

**Several steps at once (built, off by default).** When the scheduler is on, steps that do not depend on each other and do not change the same files run at the same time, across campaigns and projects, and a busy project cannot hold up a quiet one. It is off unless the data directory's `config.json` says `"scheduler": { "enabled": true }`. Off, every campaign runs one operation at a time, exactly as before. Turning it on at workstation is a runtime configuration change made through the upgrade procedure (section 6), after the owner's answer on the live scheduler (slice RUN10; [ADAPTIVE_SCHEDULER](design/ADAPTIVE_SCHEDULER.md#9-owner-reserved-questions) Q2 and Q3).

How it decides (`src/supervisor/scheduler.mjs`, design [ADAPTIVE_SCHEDULER §4](design/ADAPTIVE_SCHEDULER.md#4-design)):
- Each tick, every campaign settles as before (results, publication, integration), but only lists its ready steps. One admission pass then orders all of them and starts **at most one** per tick, so lease renewals stay on time.
- Order: the project served least recently first, then the campaign served least recently, then verify before implement, then declaration order. "Served" is the newest operation's time, read from the store.
- A step starts only if all of these pass, checked from the store and again inside the transaction that records it. The first that fails is its one wait reason:
  - `already-running`: the step already has an open operation;
  - `campaign-fanout`: the campaign's learned fan-out is full. Fan-out starts at 1, rises by 1 after a useful result while a step of the campaign waited for it, falls by 1 on a failed run and drops to 1 on two failures within one backoff window. It never exceeds `limits.slots` (`"auto"`: the host ceiling). It is kept in the store's `capacity` table and journalled (`fanout-raised`, `fanout-lowered`);
  - `host-capacity`: open operations across all campaigns reached the host ceiling, `scheduler.maxWorkers` (1..32), default a quarter of the cores between 1 and 4. This protects the computer; it is not an AW-002 limit and never notifies the owner;
  - `write-domain`: another step holds an overlapping write domain (section 1). A published change keeps its domain until it is in the base branch. While a step waits for one, the base is fetched at most once per `integrationPollMs`, and the holder's PR is read once (REST) to recognise a squash or rebase merge of its exact head;
  - `provider-cooldown`: every authorized provider for the step is waiting (section 4);
  - `launch-turn`: admissible, but this tick already started one.
- With the scheduler on, a cost ceiling that is reached only because open runs are reserved waits for those runs instead of asking the owner (B3 comes when nothing is open).

The wait reasons are kept by the controller for status; showing them in `status` and the dashboard is slice RUN9.

Not yet implemented:
- GitHub webhook intake and conditional-GET reconciliation (slice B);
- Telegram (or any real) notification transport, snooze, and reminders/incident timing beyond the section 10 defaults ([example-org/aiworks#1](https://github.com/example-org/aiworks/issues/1));
- host pressure sampling and per-account concurrency for the scheduler (slices RUN7 and RUN8), and wait reasons in `status` (RUN9);
- a project release adapter (slice C);
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

Every implementer and verifier prompt for a commit or report task, whichever provider runs it, says that repository CI runs `npm run check` on `ubuntu-latest`, so platform-specific tests guard themselves without weakening the Windows check ([#42](https://github.com/example-org/aiworks/issues/42)). It also says to copy test summary lines verbatim, and tells verifiers that a tally that does not match their own re-run of the same gate at the same head is a blocking finding ([#43](https://github.com/example-org/aiworks/issues/43)). Web-task prompts run no gate and do not carry these rules.

Commit-task prompts also say that the full gate can take 20 to 30 minutes while other work runs. The worker runs it only through the gate helper `src/supervisor/gate.mjs`, named by its absolute path in the prompt: `start` runs it as a separate process that records its own exit code, and `wait` returns when it ends, after at most 25 minutes with `running`, or at once with `died` when the gate process ended without an exit code. A worker then starts it once more instead of waiting out its time bound on a log line that cannot appear. It copies the final summary block verbatim, never shortening the suite ([#102](https://github.com/example-org/aiworks/issues/102)). Every file the gate writes ends in `.log`, which git ignores (`gate.log`, `gate-exit.log`, `gate-pid.log`, `gate-previous.log`): any other new or changed file in a verifier's checkout makes its result invalid ([#135](https://github.com/example-org/aiworks/issues/135)). Report and research-only prompts do not carry this rule.

Verifier prompts for commit and report tasks also say that a check that behaves as intended is a pass. That includes a mutation or base comparison whose expected failure was seen, and a full-suite run whose only failure is an unrelated timing test that passes on a re-run. `fail` is only for an outcome that shows a defect in the change, and `accepted` never comes with a failed check ([#59](https://github.com/example-org/aiworks/issues/59)). Implementer and web-task prompts do not carry this rule.

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

The coordinator is a single-slot lane with its own lease (`_coordinator`), separate from campaign slots and budgets. It runs Claude headless with the same isolation as campaign workers, in Claude's `dontAsk` mode: every tool call not on an explicit allowlist is denied without a prompt.

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

Crash and restart: every record, parent, probe and notification change commits in the same fenced transaction as the campaign/task change it belongs to. A probe run is an ordinary recorded operation, so a restart between checkpoint and launch launches the same operation once (`tests/supervisor/owner-intervention.test.mjs`); held tasks stay held until the probe's result is applied. A `rechecking` record whose probe task is waiting (backoff or usage limit) keeps holding the others.

Notification delivery: a transport is `{ name, live, send({ key, message }) }`. Only the no-op transport ships (`live: false`), so entries stay `pending` and nothing leaves the host. With `"deliver": true` and an injected live transport (tests use an in-memory fake), the attempt is counted before `send`, delivery is at-least-once with the stable key for deduplication, failures back off by `outboxRetryMs` × attempts and stop as `failed` after 5 attempts. There is no network, Telegram or credential code path.

Owner-gated before enabling on workstation: choose the bot/transport and its secret reference (Infisical/runtime, never this repository) and the owner chat reference; implement and review that adapter; decide snooze policy and the B5 incident path; confirm the schedule defaults; then turn on `enabled` and later `deliver` for one campaign as a canary.

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

**In short.** No release runs. Every project and destination is **Review only**: the supervisor publishes checked results and never deploys them; it merges only under the opt-in merge gate (section 3), which is not a release ([AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception)). Auto Release ([#13](https://github.com/example-org/aiworks/issues/13), [design](design/AUTO_RELEASE.md)) is being built switched off. Turning it on waits for the owner's decision on [#33](https://github.com/example-org/aiworks/issues/33).

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

Project connectors accept an explicit `tenantId`. When omitted, the installation-local identity `local` is used; existing stored project identities are unchanged.

## 13. CAAM account profiles (built, not enabled)

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
