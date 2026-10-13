# AIWorks product constitution

## Purpose

AIWorks runs explicitly authorized AI tasks with durable ownership, bounded context, separate verification and honest progress reporting. It reduces repeated prompting while leaving decisions and authority with the operator.

## Product and audience

AIWorks is a local delivery supervisor, coordinator, dashboard and worker-context runtime for repositories configured by its operator. Public source distribution does not turn the local dashboard into a hosted service.

## Outcomes

The dashboard should make progress and blockers understandable in under a minute. Measure avoidable operator interruptions and time authorized work waits unnecessarily. Baselines and measurements are installation data and are not published here.

## Boundaries

- Work starts only under explicit campaign authority. A backlog item alone is not an assignment.
- Every deliverable receives separate verification of its exact revision or report digest.
- The supervisor may create worktrees, task branches, pull requests and issue comments. It never merges, deploys or changes provider resources.
- Worker permission denials are never routed around through another provider.
- The dashboard remains loopback-only without a separately reviewed authentication layer.
- Governance is supplied by a separately configured read-only directory. AIWorks does not publish an operator's project inventory or policies.
- Campaigns, authorization text, operational state and evidence are private data, outside the public commit scope.

See [decisions](DECISIONS.md), [agent rules](../AGENTS.md) and [the runbook](SUPERVISOR.md) for enforcement and operation.
