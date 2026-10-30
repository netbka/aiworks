# Decisions

These decisions describe reusable product boundaries. Private authorizations and installation history are kept outside this repository.

## AW-001 - The delivery supervisor is the one external-write exception

For a registered campaign, the supervisor may create worktrees and task branches and record verified results. For a target repository published through GitHub, it may push a verified task branch, open a pull request and post issue comments there. For AIWorks's own repository with local main trusted ([AW-005](#aw-005---runtime-code-must-be-merged-declarations-remain-private)), it records results, reports and notes in the local work list and makes no GitHub write for them. Workers do not publish directly. The supervisor deploys or releases only under an AW-010 grant, never into its own live runtime, and never changes provider resources.

It merges only under the merge gate, and only when the owner opts in ([#138](https://github.com/example-org/aiworks/issues/138), owner decision 2026-10-14). The opt-in is `config.json` `merges.delegatedTo: "supervisor"` with an explicit list of repositories; it is off by default. It merges only when merging puts exactly the independently verified tree on the base branch, and only with a merge commit: never a squash, a rebase, a force-push, an admin bypass or a branch deletion. A GitHub pull request is merged by GitHub's merge call at the verified head. In AIWorks's own repository with local main trusted, the merge commit is made locally, with the trusted tip and the verified head as its parents and the verified tree as its tree; `main` moves to it only from the trusted tip, and the main ledger records it. When the trusted tip moved under the verified head and `merges.refresh` is set, that local merge commit carries instead exactly the merge result of the two that a passed refresh gate ran on, as GitHub's merge does after a refresh; anything else is an integration repair. The gate is in [the runbook](SUPERVISOR.md#merge-gate).

When the owner turns the backup on, the supervisor may push the trusted tip of local main to the configured GitHub branch, never with force; nothing waits on that push. Once, after the owner confirms the list in the dashboard, it may comment on and close the GitHub issues it imported into the local work list, each with a note naming its local item; it closes nothing else (owner decisions (e) and (f), 2026-10-16).

The supervisor may remove the worktrees of finished tasks and delete the local task branches that the trusted main already contains. It never deletes a remote branch, a worktree with uncommitted or untracked files, or run evidence ([AW-010](#aw-010---auto-release-is-a-separate-release-role-under-a-standing-per-project-grant) (l)).

Scope narrowed by AW-010 for the separate release role.

## AW-002 - Campaigns have no capacity limits by default

Optional run, repair, retry and cost limits must be explicit. Provider availability, permission controls and the no-progress guard still apply. Unknown cost remains unknown unless a declared conservative cost bound supplies its interpretation.

## AW-003 - The operations dashboard is local only

Bind to loopback. Mutating requests require exact origin checks, CSRF protection, bounded input and current version, scope and authorization. Remote access needs a separately reviewed authentication design.

## AW-004 - The coordinator is read-only

The coordinator reads assigned repositories and reports plans and answers locally through the supervisor and dashboard. Planning creates no GitHub issue, pull request or comment. Each plan request retains its selected repository and is processed separately. It does not edit source, merge, deploy, change provider resources or register campaigns. Execution belongs to explicitly registered campaigns, whose publication stays in their declared target repository.

## AW-005 - Runtime code must be merged; declarations remain private

New execution and coordinator work require a runtime revision that is an ancestor of the trusted main. The trusted main is `origin/main`, unless the owner set `selfHosting.trustedMain: "local"` for AIWorks's own repository (owner decision 2026-10-16). Then it is the newest commit of the main ledger that is still on local `main`: a merge the merge gate made, the anchor recorded when local trust was switched on (equal to `origin/main` at that moment), or a commit the owner recorded through the dashboard's owner route. A commit on local `main` that none of these put there is not trusted until one does. An upgrade deploys the trusted main. Operator campaign files are local JSON data and are not committed. Explicit `start` reads and validates a private file; scope is immutable and amendments need a higher authorization version. Dashboard Resume uses the previously registered declaration with atomic version and authority checks. This supersedes any earlier requirement to commit declarations.

## AW-006 - No cross-machine dashboard view

One installation owns one state directory and its local services. Combined machine views are not part of the current access model.

## AW-007 - AIWorks is a standalone product

AIWorks owns its reusable supervisor, dashboard and worker-context runtime. Governance is an operator-supplied read-only directory conforming to the documented contract.

## AW-008 - Provider order is explicit in private campaign authority

A campaign may declare an ordered provider chain. Quota or unavailable-provider conditions can select another authorized provider. Permission denials, sandbox refusals and verification failures cannot. Changing providers follows the existing executor-handover and authorization rules.

## AW-009 - Public commits contain no installation data

Campaign declarations, actual project inventories, machine configuration, authorizations, credentials, logs and run artifacts are excluded. Examples and tests are synthetic. Publication must cover history and repository metadata as well as the current source tree; see [publication preparation](PUBLICATION.md).

## AW-010 - Auto Release is a separate release role under a standing per-project grant

Status: accepted by the owner on 2026-10-17 ([#33](https://github.com/example-org/aiworks/issues/33) item 1: "yes"; item 2: "do it easier. I don't want to watch after tokens now"). Recorded from [the Auto Release design, section 10.1](design/AUTO_RELEASE.md#101-proposed-aiworks-decision-aw-008), with the owner decisions (h) to (m) of [the plan, section 8](PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates). It narrows the scope of AW-001; it does not replace it.

AW-001 stays: the supervisor that runs campaigns merges only under the merge gate, and deploys or releases nothing outside this decision.

A separate **release role** may deploy one result, merge it in a repository the merge gate does not cover, or apply it to a local target, only when all of these hold:

- the target project records a standing release authorization that names AIWorks, the destination, the change classes and an expiry of at most 90 days, and it is valid, unexpired and not revoked;
- an independent verifier accepted that exact revision;
- every eligibility check in [the Auto Release design, section 5](design/AUTO_RELEASE.md#5-eligibility-of-one-exact-verified-revision) passes on positive evidence;
- no `RELEASE-STOP` file exists and the project's mode is Auto Release.

The release role is deterministic code, not a model. Each release step runs in its own clean process, apart from every implementer, verifier and coordinator process.

- **(i) No release token.** A release uses the logins already on this computer: the operator's `gh` login for a merge, as the merge gate does, and the project's own `deploy`, `observe`, `check` and `rollback` commands with the access they already have. AIWorks creates, stores and renews no credential. The grant, checked in code before every step, limits a release to its repository and destination. An expired grant only returns the destination to Review only.
- **(j) The first canary.** A disposable rehearsal comes first. Then one grant for one owner project's production destination, `docs` and `tests` changes only, for 30 days. `app-code` needs a newer grant after those releases ran cleanly.
- **(k) One merge path per repository.** In a repository the merge gate covers, only the merge gate merges. A release there deploys the merge commit the gate recorded, after the tree check, and never makes a merge call of its own.
- **(l) Cleanup after finished work.** The supervisor removes the worktrees of finished tasks and deletes the local task branches that the trusted main already contains. It never deletes a remote branch, a worktree with uncommitted or untracked files, or run evidence. Nothing is cleaned before this cleanup is built and switched on.
- **(m) AIWorks's own live runtime.** Upgrades stay manual, through the upgrade procedure in [the agent rules](../AGENTS.md#review-and-runtime-maintenance).

The release role never: releases a database migration, infrastructure or permission change, or anything adding recurring spend; releases to a destination or environment not in the grant; releases AIWorks into its own live runtime; repeats a step whose outcome is unknown. A failed rollback is an incident. Without a valid grant every project is in Review only, which is the behaviour of AW-001 alone.

## AW-011 - The next wave starts by itself under an owner-approved program record

Status: accepted by the owner on 2026-10-17 ([#153](https://github.com/example-org/aiworks/issues/153) option B: "stop asking me questions. just do it."). Recorded from the owner decision (n) of [the plan, section 8](PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates), bounded by [lane PROG, section 6.8d](PROJECT_WORKSPACE_PLAN.md#68d-lane-prog---the-next-wave-starts-by-itself).

When a wave of work ends, AIWorks may register the next wave itself, without a session writing the declaration and without the owner running `start`. It does so only under all of these:

- The owner approved one private program record once. It is digest-bound and kept outside source Git, like every declaration (AW-005, AW-009). It names the repository and base branch, the plan file, the slices allowed and the slices excluded, the executor chain and the constraints every task carries. Its version only goes up; a newer version replaces it.
- The supervisor builds each wave's declaration from the plan on the trusted main by fixed rules, not by a model. The same plan revision and record always give the same declaration.
- It registers a wave only when every slice fits the record exactly and the runtime passes the merged-code check of AW-005. A wave never starts while an earlier wave of the program has unfinished tasks.
- Anything that does not fit is not registered. It becomes one Needs you item with the reason and the proposed declaration.
- Runbook-only slices, which change the live install, are never proposed.
- `revoked: true` in the record, or a `PROGRAM-STOP` file in the data directory, stops every new wave at once.

A wave registered this way is a registered campaign: campaign scope, the authorization version and independent verification of every task stay binding (AW-001, AW-004, AW-005). The program record grants no merge, release, deploy or provider power that AW-001 and AW-010 do not already grant.

Decided is not switched on. Lane PROG builds this switched off: `program.enabled` in `config.json` is absent or malformed means off. PROG5 switches it on with the owner's first program record, through the upgrade procedure.

## AW-012 - Local projects start from an owner approval in the dashboard

Owner decision 2026-10-16 ([#32](https://github.com/example-org/aiworks/issues/32), D4). The owner said: "This AIworks should work with no dependency on Github." The answer recorded on #32: approving a plan in the local dashboard admits exactly that plan, bound to its digest, with no signing key.

All campaign declarations remain private. Merged, reviewed executable code and explicit owner authority stay required for every project.

A campaign whose target is a connected local project (Local Git or plain folder) is registered when the owner approves its plan in the local dashboard. The supervisor checks each point below at registration and before every dispatch, and fails closed:

1. **Merged, reviewed, pinned code.** The supervisor runs from a reviewed revision, as [AW-005](#aw-005---runtime-code-must-be-merged-declarations-remain-private) says. Nothing in an approval or declaration is executed as code.
2. **Owner approval in the dashboard.** The approval record binds that exact plan by its digest. There is no signing key.
3. **From the owner, not from AIWorks.** The dashboard refuses an approval that comes from a process AIWorks started, and refuses when it cannot tell.
4. **Governed project.** The project has rules the owner confirmed in the dashboard, not revoked or expired, and the approval binds their digest. A project with GitHub can never use this path.
5. **Append-only ledger.** Each approval and revocation is appended to a local hash-chained ledger. A broken ledger stops new dispatches until the owner approves again.
6. **Same limits as every campaign.** For a local project the supervisor never merges, deploys or writes the owner's folder by itself ([AW-001](#aw-001---the-delivery-supervisor-is-the-one-external-write-exception)). Workers run on AIWorks's own copy of the project. A result is a verified local candidate; only the owner's Apply writes it to the folder. Reports and blockers stay in this computer's records, and nothing for the project calls GitHub.
7. **Revocation.** Revoking or expiring the project's rules, or revoking the approval, stops new dispatches at the next check. Running operations finish and are recorded, as with a pause.

This changes where an owner approval may come from, for local projects only. It does not let unmerged code run, and it does not change the GitHub path. The design is [WORK_ENVELOPE.md section 8](design/WORK_ENVELOPE.md#8-decision-d4-local-admission-without-github).

## AW-013 - Planned files are a plan, not a stop

Owner decision 2026-10-19: "Agents should work to the plan, but if they need something else they do not stop; they do it, record it and explain why. Whoever accepts the work judges correctness, fitness and whether it works, and gives feedback: accept or send back for rework."

A task's `writes` (and an envelope's `writes`) are the planned files. They still decide which tasks may run side by side, as the scheduler reads them. A commit that also changes other files is no longer a boundary violation:

- The implementer changes the extra file the outcome needs and lists each one in its report with the reason. It does not stop to ask.
- The controller lists the changed files outside the plan in the verifier's packet. The verifier accepts each one only when the outcome needs it, the change is correct and minimal, and the report explains it; otherwise it rejects with a finding, which starts the usual repair round.
- Still a boundary violation, held for the owner: any secret-like path, and any path inside an envelope's `denyWrites`, wherever it lies.

Campaign scope otherwise stays binding: the outcome, the acceptance, the target repository and branch, the authorization version and independent verification (AW-001, AW-005).

## AW-014 - Waiting pull requests merge as one group after one gate run

Owner decision 2026-10-19: "When a merge queue builds up, merge them all. The checks were already run before publishing; check the combined result once after the cycle instead of turning every merge into a blocker."

Each pull request was verified on its own, on the base it started from. What lands on the base is the combination, so the combination is checked, once:

- With `merges.batch: true` (and `merges.refresh`, which names the gate command), two or more verified pull requests waiting for one base form a group. The supervisor builds their combined result locally, runs the gate once on that exact tree, then merges them on GitHub in the same order.
- Each merge happens only while the base is exactly the previous step of the checked chain, and its merge commit must carry the tree that step predicted. Otherwise the group stops.
- A pull request that conflicts stays out of the group. A failed gate ends the group, and its pull requests go one at a time as before (a moved base is gated alone, or repaired). The same group on the same base is never gated twice.

The merge gate's other rules stay: only listed repositories, only the exact verified heads, merge commits only, never a squash, rebase, force-push or branch deletion (AW-001).

## AW-015 - Acceptance controls merging when the owner chooses it

Owner decision 2026-10-21 ([#45](https://github.com/example-org/aiworks/issues/45)): each project has an acceptance mode, *automatic* (today's behaviour, the default) or *I accept results myself*. In the second mode the merge gate merges a verified head only after the owner has accepted exactly that checked version. Acceptance of an earlier head never counts.

- The mode is one more owner-set field of the versioned project settings (`acceptance`: `"automatic"` or `"owner"`), saved only by the owner under the existing settings rules: the caller check, the version the owner saw and a request id. A project that never set it is automatic, and merges exactly as before.
- In the owner's mode every merge path (one at a time, the refresh, the group merge of AW-014 and the local merges of AIWorks's own repository) merges only a head with a recorded acceptance of exactly that verified head and the report it was checked with. The newest settings are read at every check and again in the fenced write before a merge, so the rule holds after a restart. A waiting request for changes still holds the head.
- Switching to the owner's mode holds every unmerged head without acceptance; switching back lets the existing gate continue. Waiting versions are listed in Needs you with Accept and Request changes.

Acceptance still never merges by itself: the merge gate's other conditions and AW-001 stay. A project without GitHub is accepted by Apply, as before.

## AW-016 - Needs you holds only what the owner alone can decide

Owner decision 2026-10-29: AIWorks works for the owner, not the other way round. Needs you, its count and the Home headline hold only what changes the product and only the owner can answer. Everything else AIWorks settles inside the authority it already has, or lists apart as its own state, never counted.

| Situation | Who |
| --- | --- |
| An owner-reserved decision with a suggestion that the worker marked reversible | AIWorks answers with the suggestion at once and tells the owner, who can change it while the step is being made. At most once per step under one approval; any later decision on that step, and every stall at the repair limit, waits for the owner |
| A decision without a usable suggestion | The owner. Workers are told to give 2 to 4 options and a suggestion |
| A checked result waiting for acceptance; a merge left to someone else that stalled; an accepted result AIWorks may not merge; a failed rollback | The owner |
| A published result without an independent check on record | AIWorks checks it again by itself, once per version, within the approved plan, unless it was merged, closed or pushed by someone else; then it stays the owner's to plan again or leave |
| Work AIWorks has not looked at for a while; AIWorks stopped on this computer; a step stopped by failures, a missing tool or no AI worker for it; merge problems; results not recorded; an unknown release outcome; unreadable messages | AIWorks's own state: listed apart with what it does next, not counted |
| Changes the owner requested on paused or cancelled work | Settled when they are requested: the request offers to resume. Not listed afterwards |

A decision answered by AIWorks keeps its question, options and reason in the record. Answering it never widens the packet (decisions.mjs). A decision is only answered automatically when the worker said the suggestion changes nothing outside the step's own work and can be undone in a later round: no spending, credentials, deleted data, publishing or access changes. The owner still accepts the result as before.
