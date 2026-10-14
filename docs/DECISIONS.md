# Decisions

These decisions describe reusable product boundaries. Private authorizations and installation history are kept outside this repository.

## AW-001 - The delivery supervisor is the one external-write exception

For a registered campaign, the supervisor may create worktrees, task branches, pull requests and issue comments in its target repository. Workers do not publish directly. The supervisor never deploys, releases or changes provider resources.

It merges only under the merge gate, and only when the owner opts in ([#138](https://github.com/example-org/aiworks/issues/138), owner decision 2026-10-14). The opt-in is `config.json` `merges.delegatedTo: "supervisor"` with an explicit list of repositories; it is off by default. It merges a pull request only when merging it puts exactly the independently verified tree on the base branch, and only with a merge commit: never a squash, a rebase, a force-push, an admin bypass or a branch deletion. The gate is in [the runbook](SUPERVISOR.md#merge-gate).

## AW-002 - Campaigns have no capacity limits by default

Optional run, repair, retry and cost limits must be explicit. Provider availability, permission controls and the no-progress guard still apply. Unknown cost remains unknown unless a declared conservative cost bound supplies its interpretation.

## AW-003 - The operations dashboard is local only

Bind to loopback. Mutating requests require exact origin checks, CSRF protection, bounded input and current version, scope and authorization. Remote access needs a separately reviewed authentication design.

## AW-004 - The coordinator is read-only

The coordinator reads assigned repositories and reports plans and answers locally through the supervisor and dashboard. Planning creates no GitHub issue, pull request or comment. Each plan request retains its selected repository and is processed separately. It does not edit source, merge, deploy, change provider resources or register campaigns. Execution belongs to explicitly registered campaigns, whose publication stays in their declared target repository.

## AW-005 - Runtime code must be merged; declarations remain private

New execution and coordinator work require a runtime revision that is an ancestor of `origin/main`. Operator campaign files are local JSON data and are not committed. Explicit `start` reads and validates a private file; scope is immutable and amendments need a higher authorization version. Dashboard Resume uses the previously registered declaration with atomic version and authority checks. This supersedes any earlier requirement to commit declarations.

## AW-006 - No cross-machine dashboard view

One installation owns one state directory and its local services. Combined machine views are not part of the current access model.

## AW-007 - AIWorks is a standalone product

AIWorks owns its reusable supervisor, dashboard and worker-context runtime. Governance is an operator-supplied read-only directory conforming to the documented contract.

## AW-008 - Provider order is explicit in private campaign authority

A campaign may declare an ordered provider chain. Quota or unavailable-provider conditions can select another authorized provider. Permission denials, sandbox refusals and verification failures cannot. Changing providers follows the existing executor-handover and authorization rules.

## AW-009 - Public commits contain no installation data

Campaign declarations, actual project inventories, machine configuration, authorizations, credentials, logs and run artifacts are excluded. Examples and tests are synthetic. Publication must cover history and repository metadata as well as the current source tree; see [publication preparation](PUBLICATION.md).
