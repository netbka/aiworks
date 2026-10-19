# AIWorks product constitution

## Purpose

AIWorks runs explicitly authorized AI tasks with durable ownership, bounded context, separate verification and honest progress reporting. It reduces repeated prompting while leaving decisions and authority with the operator.

## Product and audience

AIWorks is a local delivery supervisor, coordinator, dashboard and worker-context runtime for repositories configured by its operator. Public source distribution does not turn the local dashboard into a hosted service.

## Outcomes

The dashboard should make progress and blockers understandable in under a minute. Measure avoidable operator interruptions and time authorized work waits unnecessarily. Baselines and measurements are installation data and are not published here.

## Boundaries

- Work starts only under explicit campaign authority: a campaign the owner registered, or a wave the supervisor registered under an owner-approved program record that it fits exactly ([AW-011](DECISIONS.md#aw-011---the-next-wave-starts-by-itself-under-an-owner-approved-program-record)). A backlog item alone is not an assignment.
- Every deliverable receives separate verification of its exact revision or report digest.
- The supervisor may create worktrees and task branches; where a target repository publishes through GitHub, also pull requests and issue comments. For AIWorks's own repository with local main trusted, results and notes go to the local work list instead. It merges a verified result only under the merge gate, with a merge commit of exactly the verified tree, in a repository the owner opted in ([AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception)). New work runs only from code merged into the trusted main ([AW-005](DECISIONS.md#aw-005---runtime-code-must-be-merged-declarations-remain-private)). It deploys or releases only under an [AW-010](DECISIONS.md#aw-010---auto-release-is-a-separate-release-role-under-a-standing-per-project-grant) grant, never into its own live runtime, and never changes provider resources. It may remove the worktrees of finished tasks and delete the local task branches the trusted main contains, never a remote branch, a worktree with changes or run evidence.
- Worker permission denials are never routed around through another provider.
- The dashboard remains loopback-only without a separately reviewed authentication layer.
- Governance is supplied by a separately configured read-only directory. AIWorks does not publish an operator's project inventory or policies.
- Campaigns, authorization text, operational state and evidence are private data, outside the public commit scope.

See [decisions](DECISIONS.md), [agent rules](../AGENTS.md) and [the runbook](SUPERVISOR.md) for enforcement and operation.
