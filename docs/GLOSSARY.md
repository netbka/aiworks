# Glossary

This page decodes the terms and IDs used in AIWorks. It defines no rules; the linked documents do.

## Terms

- **Campaign.** An owner-registered set of tasks that the supervisor runs in one target repository. It is declared in `campaigns/<id>.json`: authorization, target, tasks and their dependencies, limits and executor. Its scope cannot change; an amendment needs a higher `authorization.version`. See [SUPERVISOR.md](SUPERVISOR.md).
- **Task.** One step of a campaign, with a goal, acceptance criteria and a deliverable: a `commit` (a pushed branch and a PR) or a `report` (a comment on the task issue).
- **Operation.** One recorded worker run for a task, such as an implementation or a verification. It has an idempotency key `<campaign>.<task>.<kind>.<seq>`, a packet and its digest, and it is committed to the store before the runner starts ([SUPERVISOR.md §3](SUPERVISOR.md#3-lifecycle-of-one-task)).
- **Controller.** The long-running `serve` process that steps every campaign. `keep` restarts it after any exit.
- **Lease.** The right of one controller instance to act for a campaign, with a generation number. Every controller write checks it first. An expired lease is taken over with generation + 1 ([SUPERVISOR.md §2](SUPERVISOR.md#2-state-and-ownership)).
- **Task packet.** The bounded, revision-pinned input a worker gets, bound by its digest ([WORKER_CONTEXT_LIFECYCLE.md §3](WORKER_CONTEXT_LIFECYCLE.md#3-task-packet-and-durable-checkpoint)).
- **Executor, provider chain.** The worker CLI, or ordered list of CLIs, a campaign may use: Claude, Codex, Cursor, AGY ([SUPERVISOR.md §8](SUPERVISOR.md#8-ordered-cli-execution)).
- **Verifier.** A separate fresh session that checks a result read-only at the exact commit before anything is published.
- **Coordinator.** A read-only agent that answers the owner's messages and plans work. It never registers or starts a campaign; the supervisor posts its answers ([AW-004](DECISIONS.md#aw-004---owner-messages-go-to-a-read-only-coordinator-agent)).
- **Governance checkout (governance root).** A plain clone of `netbka/engineering-platform` main. AIWorks reads the project registry, policies and schemas from it and never writes to it ([SUPERVISOR.md §6](SUPERVISOR.md#governance-checkout)).
- **Runtime checkout.** `.local/runtime`: the detached checkout of the reviewed commit that the supervisor and dashboard run from. It changes only through the [upgrade procedure](SUPERVISOR.md#upgrade).
- **Data directory.** `.local/supervisor`: `config.json`, the SQLite store, journal, log and run artifacts.

## IDs

| ID | Meaning | Defined in |
| --- | --- | --- |
| AW-0nn | Accepted AIWorks decisions | [DECISIONS.md](DECISIONS.md) |
| B0–B5 | Blocker classes: transient, agent-resolvable, owner action, owner decision, external wait, critical incident | [OWNER_INTERVENTION.md](https://github.com/netbka/engineering-platform/blob/main/docs/OWNER_INTERVENTION.md#2-blocker-classes) |
| C0–C4 | Slices of the worker context lifecycle. C0 is the contract and helpers; the supervisor is the runtime. | [WORKER_CONTEXT_LIFECYCLE.md](WORKER_CONTEXT_LIFECYCLE.md) |
| Slices A–D | Delivery stages of the supervisor (A = store, campaign, worker, verifier) | [SUPERVISOR.md](SUPERVISOR.md) |
| `ACTIVE`, `CONTROLLER_OFFLINE`, … | Readiness values reported by `status` | [SUPERVISOR.md §5](SUPERVISOR.md#5-commands) |
| WAVE-nn | Tasks of the DYK campaign `dyk-443-waves` | `campaigns/dyk-443-waves.json` |
| P1–P9, PLAN-01 in `elma-wiki-*` campaigns | Task labels of the elma_wiki campaigns, which run on the owner's second PC | `campaigns/elma-wiki-*.json` |
| GOV-21A, GOV-21D | Older package names from Engineering Platform, still in the titles of [netbka/aiworks#1](https://github.com/netbka/aiworks/issues/1) (owner notification) and [netbka/aiworks#2](https://github.com/netbka/aiworks/issues/2) (supervisor) | GitHub |
