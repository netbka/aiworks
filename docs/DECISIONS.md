# Decisions

Accepted AIWorks decisions. AW-001 to AW-006 were first accepted in Engineering Platform, as EP-032 to EP-036 and EP-038 of the archived decision log. They were carried over with the same substance, dates and owner authority when AIWorks became a separate product ([AW-007](#aw-007---aiworks-is-a-standalone-product-separate-from-engineering-platform)). The earlier records are in the private archive `netbka/engineering-platform-archive`.

Portfolio decisions stay in Engineering Platform: [docs/DECISIONS.md](https://github.com/netbka/engineering-platform/blob/main/docs/DECISIONS.md).

## AW-001 - The delivery supervisor is the one external-write exception

Status: accepted with the supervisor program ([netbka/aiworks#2](https://github.com/netbka/aiworks/issues/2)); recorded 2026-10-10 (archived as EP-032 in netbka/engineering-platform-archive)

For a campaign the owner explicitly registered, the delivery supervisor may create worktrees, campaign branches, PRs and issue comments in that campaign's target repository. It never merges, deploys or changes provider resources. Agent work in this repository otherwise stays bound by [AGENTS.md](../AGENTS.md). Runbook: [SUPERVISOR.md](SUPERVISOR.md).

## AW-002 - Campaigns have no capacity limits by default

Status: accepted by the owner (PRs [#69](https://github.com/netbka/engineering-platform-archive/issues/69), [#72](https://github.com/netbka/engineering-platform-archive/issues/72)); recorded 2026-10-10 (archived as EP-033 in netbka/engineering-platform-archive)

Work stops only when a provider reports its subscription or usage limit, and the campaign then waits for the reset. A run cap, retry cap or cost ceiling exists only when the owner declares one in the campaign. Waiting on an accepted provider limit is an external wait, not an owner notification ([OWNER_INTERVENTION.md](https://github.com/netbka/engineering-platform/blob/main/docs/OWNER_INTERVENTION.md#rate-limits--quotas)).

## AW-003 - The operations dashboard is local-only

Status: accepted with the dashboard package ([#60](https://github.com/netbka/engineering-platform-archive/issues/60), PR [#61](https://github.com/netbka/engineering-platform-archive/issues/61)); recorded 2026-10-10 (archived as EP-034 in netbka/engineering-platform-archive)

The dashboard binds to `127.0.0.1` on the owner's machine. It is not exposed through a proxy, tunnel or public interface without a separately reviewed authentication layer. Its commands reuse supervisor authority and never widen it.

## AW-004 - Owner messages go to a read-only coordinator agent

Status: accepted by the owner (PRs [#68](https://github.com/netbka/engineering-platform-archive/issues/68), [#71](https://github.com/netbka/engineering-platform-archive/issues/71)); recorded 2026-10-10 (archived as EP-035 in netbka/engineering-platform-archive)

A coordinator agent reads the messages the owner sends from the dashboard, using allowlisted read-only tools. It posts its replies to GitHub and never runs inside the live supervisor runtime. It plans and explains; it does not merge, deploy or register campaigns.

## AW-005 - Campaigns run only from merged supervisor code and a declaration on main

Status: accepted 2026-10-11 by the owner ([#83](https://github.com/netbka/engineering-platform-archive/issues/83)) (archived as EP-036 in netbka/engineering-platform-archive)

A campaign may not run from a supervisor revision that is not merged to main, and may not run without its declaration file in `campaigns/` on main. This answers what happened on 2026-10-10, when the second PC's elma-wiki campaigns ran from an unmerged controller revision ([#79](https://github.com/netbka/engineering-platform-archive/issues/79)).

Since [AW-007](#aw-007---aiworks-is-a-standalone-product-separate-from-engineering-platform), "main" means the main branch of `netbka/aiworks`.

Follow-up: enforce this in supervisor registration and resume ([SUPERVISOR.md](SUPERVISOR.md)). Progress is in [STATUS.md](STATUS.md).

## AW-006 - No cross-machine dashboard view

Status: accepted 2026-10-11 by the owner ([#79](https://github.com/netbka/engineering-platform-archive/issues/79)) (archived as EP-038 in netbka/engineering-platform-archive)

The owner fixed the two-PC situation themselves. A dashboard view that combines several machines will not be built. Each machine's dashboard names its own host and revision ([#91](https://github.com/netbka/engineering-platform-archive/issues/91)). The other #79 items were closed with this decision, not built: showing the supervisor data directory in the sidebar, and a runbook note that browser automation can reach any browser connected to the account.

## AW-007 - AIWorks is a standalone product separate from Engineering Platform

Status: accepted 2026-10-12 by the owner

The AI delivery machine leaves the Engineering Platform repository and becomes its own product, AIWorks, in the private repository `netbka/aiworks`. The owner earlier called this machine "HandsOn".

- **Scope.** Only the machine moves: the delivery supervisor (with the coordinator, the executors and the Windows process containment), the operations dashboard, the campaign declarations, the worker-context runtime, their tests and their runbooks. Portfolio governance stays in Engineering Platform: the constitution, policies, project registry, schemas and the portfolio agent rules (Agent Operating Model, Continuation, Owner Intervention, AGENT-001). AIWorks follows those rules and does not copy them.
- **Governance is read, not owned.** AIWorks reads Engineering Platform's governance files through a read-only governance checkout, a plain clone of `netbka/engineering-platform` main ([SUPERVISOR.md §6](SUPERVISOR.md#6-running-on-homepc)). Without one, the code that needs it fails closed; it never falls back to the AIWorks code. AIWorks is registered in Engineering Platform as an ordinary project.
- **Fresh store.** AIWorks starts with an empty supervisor store. The previous records (the SQLite store, the run directories and the log) are archived at `D:\Backups\handson-split`.
- **Second PC.** The owner's second PC (HOMELENOVO, which runs the elma-wiki campaigns) stays on the old Engineering Platform build, unchanged. AIWorks does not manage it.
- **Decisions.** Archived EP-032 to EP-036 and EP-038 continue here as AW-001 to AW-006.
- **History.** The full earlier history stays in the private archive `netbka/engineering-platform-archive`. The open machine issues moved to `netbka/aiworks` (#1 to #5).
