# AIWorks Product Constitution

Status: the boundaries follow owner decisions [AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception) to [AW-007](DECISIONS.md#aw-007---aiworks-is-a-standalone-product-separate-from-engineering-platform). The owner adopted the two metrics on 2026-10-10, while this tooling was still part of Engineering Platform ([#77](https://github.com/netbka/engineering-platform-archive/issues/77)). Other wording is agent-written. AIWorks inherits the portfolio [Constitution](https://github.com/netbka/engineering-platform/blob/main/docs/CONSTITUTION.md) like every other registered project.

## Purpose

AIWorks is the owner's AI delivery machine. A persistent supervisor runs the campaigns the owner explicitly registered. Headless AI workers do the work: Claude, Codex and Cursor, and AGY for checks in a real browser. A separate fresh session verifies every result, and a local operations dashboard shows where things stand. The owner is interrupted only for real decisions.

## Problem

AI agents still need micromanaging. Without a machine that keeps going, someone has to tell each agent to continue, check its result, retry after a provider limit and notice when work is stuck. The owner also cannot see at a glance where each product stands or what is waiting for them.

## Product and audience

- **Audience:** the owner only. AIWorks runs on the owner's own PC for the owner's own repositories.
- **What it is:**
  - the delivery supervisor ([SUPERVISOR.md](SUPERVISOR.md)): campaigns, tasks, workers, independent verification, recovery after restarts and provider limits;
  - the coordinator: a read-only agent that answers the owner's messages and plans work;
  - the operations dashboard ([OPERATIONS_DASHBOARD.md](OPERATIONS_DASHBOARD.md)): what needs the owner first, then progress as outcomes;
  - the worker-context runtime ([WORKER_CONTEXT_LIFECYCLE.md](WORKER_CONTEXT_LIFECYCLE.md)): bounded task packets, leases and fresh sessions;
  - the campaign declarations in `campaigns/`.

## Outcomes and metrics

| Problem | Outcome | Metric |
| --- | --- | --- |
| The owner can't see where each product stands or what needs them | One screen answers it in under a minute | Hours campaigns sit idle waiting on the owner, per week |
| AI agents still need micromanaging | The owner is interrupted only for real decisions | Owner interruptions per week, and the share that were justified |

No baseline is measured yet.

## Boundaries and non-goals

- No public offering. AIWorks is not offered to anyone but the owner: no sign-up, no hosting for others and no billing.
- No merging, deploying or changing provider resources. The supervisor's only writes outside this repository are worktrees, campaign branches, PRs and issue comments for a campaign the owner registered ([AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception)). Merge and release follow each project's own gate.
- No unassigned work. The supervisor never claims backlog that no registered campaign assigns.
- No dashboard outside the local machine without a separately reviewed authentication layer ([AW-003](DECISIONS.md#aw-003---the-operations-dashboard-is-local-only)), and no combined view of several machines ([AW-006](DECISIONS.md#aw-006---no-cross-machine-dashboard-view)).
- No portfolio governance of its own. AIWorks does not define policies, project contracts or the project registry.

## Relationship to Engineering Platform

[Engineering Platform](https://github.com/netbka/engineering-platform) (EP) is the portfolio governance source: the constitution, the policies and the project registry.

- AIWorks reads EP's governance read-only, through a governance checkout ([SUPERVISOR.md §6](SUPERVISOR.md#6-running-on-homepc)). It uses it to:
  - check that a campaign targets a registered project;
  - give every worker the target project's rules;
  - show EP's roadmap on the dashboard.
- AIWorks is registered in EP as an ordinary project. Changes to EP happen through EP's own pull requests, never from AIWorks.
- AIWorks follows the portfolio agent rules. They are not repeated here:
  - [Agent Operating Model](https://github.com/netbka/engineering-platform/blob/main/docs/AGENT_OPERATING_MODEL.md): roles, one accountable Task Controller and independence;
  - [Continuation](https://github.com/netbka/engineering-platform/blob/main/docs/CONTINUATION.md): parent ownership, question routing and the completion gate;
  - [Owner Intervention](https://github.com/netbka/engineering-platform/blob/main/docs/OWNER_INTERVENTION.md): blocker classes B0–B5 and when the owner is notified;
  - [AGENT-001](https://github.com/netbka/engineering-platform/blob/main/policies/AGENT-001.json): the machine-readable agent policy.

## Where to look next

Current state: [STATUS.md](STATUS.md). Decisions: [DECISIONS.md](DECISIONS.md). Terms: [GLOSSARY.md](GLOSSARY.md). Agent rules: [AGENTS.md](../AGENTS.md).
