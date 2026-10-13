# AIWorks

Keep assigned AI work moving, and check what it actually delivered.

AIWorks runs on your Windows PC around coding tools such as Claude Code and Codex. A persistent supervisor dispatches approved work, gives the result to a separate verification session, handles recoverable waits and records the outcome. A local dashboard shows progress and what needs your attention.

**Current stage: internal preview; preparing for a public release.** The running product serves the owner's projects. A real installation still needs approved Engineering Platform governance and project registration. Public self-service setup, licensing and external-contribution safeguards must be completed before a public release. This documentation does not change repository visibility or grant an open-source license. See the [release checklist](docs/publication/RELEASE_CHECKLIST.md).

## Install and use

| I want to... | Start here |
| --- | --- |
| Understand the workflow and choose a setup path | [User documentation](docs/guides/README.md) |
| Look around without AI accounts or real projects | [Local demo](docs/guides/INSTALLATION.md#try-the-demo-without-worker-credentials) |
| Install a real local supervisor | [Windows installation](docs/guides/INSTALLATION.md#install-for-real-project-work) |
| Start work myself with a command | [First project and CLI walkthrough](docs/guides/FIRST_PROJECT.md) |
| Ask an AI assistant to start project work | [AI-assisted startup and copyable prompts](docs/guides/AI_ASSISTED_START.md) |
| Understand settings, providers and credentials | [Configuration](docs/guides/CONFIGURATION.md) |
| Diagnose a wait or failed start | [Troubleshooting](docs/guides/TROUBLESHOOTING.md) |
| Suggest or contribute a change | [Contributing](CONTRIBUTING.md) |
| Report a security problem privately | [Security](SECURITY.md) |

### Three commands with different jobs

Run these from an installed runtime checkout, with its actual data directory. Replace the example names; do not run another owner's campaign.

```powershell
# Keep the controller running in this terminal. This does not assign a task.
node src/supervisor/cli.mjs serve --data C:/Work/aiworks/.local/supervisor
```

In another terminal, in the same runtime checkout:

```powershell
# Ask the configured read-only coordinator to plan. This does not start implementation.
node src/supervisor/cli.mjs message "Plan work for my configured project; do not implement yet." --data C:/Work/aiworks/.local/supervisor

# Register or resume an owner-approved declaration already committed in this runtime's campaigns/.
node src/supervisor/cli.mjs start campaigns/my-approved-work.json --data C:/Work/aiworks/.local/supervisor
node src/supervisor/cli.mjs status my-approved-work --data C:/Work/aiworks/.local/supervisor
```

`message` needs an enabled coordinator. `start` needs an approved declaration, a registered target and a runtime revision merged to `origin/main`. A message receipt or successful registration is not proof a worker is active. The guides explain the prerequisites and the expected evidence.

### What a run does

An owner authorizes a bounded work program, called a **campaign**. A **worker** implements a task or produces a report. A different, fresh session **verifies** the result. Rejected results return for repair within the campaign's authority. The supervisor publishes a verified code change as a pull request, or a verified report as an issue comment.

The current supervisor does not merge or deploy. Auto Release is a separately governed workstream, not an installation default. A published PR, a merged change and a checked live result are different states. Provider/model availability depends on the installed adapter, role, operating system and account; listing a provider is not proof that it can run here.

## Start here

This is the engineering reading list; [AGENTS.md](AGENTS.md) points to it. The user guides above explain operation; they do not replace these authorities.

1. [Product Constitution](docs/PRODUCT_CONSTITUTION.md) - purpose, current audience and success metrics
2. [Status](docs/STATUS.md) - recorded progress; GitHub issues and PRs hold live work state
3. [Agent rules](AGENTS.md) - how changes to this repository are made
4. [Decisions](docs/DECISIONS.md) - accepted product and execution decisions
5. [Delivery Supervisor](docs/SUPERVISOR.md) - lifecycle, failures, commands, deployment layout and upgrades
6. [Operations Dashboard](docs/OPERATIONS_DASHBOARD.md) - the local owner interface
7. [Worker Context Lifecycle](docs/WORKER_CONTEXT_LIFECYCLE.md) - bounded packets, leases and fresh sessions
8. [Glossary](docs/GLOSSARY.md) - terms and IDs
9. [Workspace implementation plan](docs/PROJECT_WORKSPACE_PLAN.md) - staged project connection, intake, scheduling, routing, UI and release work

Portfolio rules come from [Engineering Platform](https://github.com/netbka/engineering-platform): its [Constitution](https://github.com/netbka/engineering-platform/blob/main/docs/CONSTITUTION.md), [Agent Operating Model](https://github.com/netbka/engineering-platform/blob/main/docs/AGENT_OPERATING_MODEL.md), [Continuation](https://github.com/netbka/engineering-platform/blob/main/docs/CONTINUATION.md) and [Owner Intervention](https://github.com/netbka/engineering-platform/blob/main/docs/OWNER_INTERVENTION.md). AIWorks reads an approved governance checkout; it does not write that checkout or replace its policies with test fixtures.

## Layout

| Path | Purpose |
| --- | --- |
| `src/supervisor/` | CLI, controller, SQLite state, coordinator, workers and verification |
| `src/supervisor/adapters/` | Worker CLI, Git and GitHub adapters |
| `src/dashboard/` | Local dashboard server and interface |
| `src/shared/` | Shared helpers |
| `campaigns/` | Actual owner-authorized work declarations; not a starter library |
| `docs/guides/` | Installation, configuration, manual/AI startup and troubleshooting |
| `docs/guides/examples/` | Inert example JSON; not executable campaign registrations |
| `docs/publication/` | Public-release checklist and deferred showcase instructions |
| `scripts/lib/worker-context.mjs` | Packet validation, context and lease helpers |
| `registry/` and `schemas/` | AIWorks runtime contracts |
| `scripts/supervisor/` | Windows task installers and reviewed runtime upgrade script |
| `tests/` | Disposable tests and a synthetic dashboard fixture |

Local source, runtime, state and worktrees must remain separate. On the owner's existing HomePc setup, these are `D:/Git/aiworks`, `.local/runtime`, `.local/supervisor`, `.local/worktrees` and `.local/governance`. New installations may use different absolute paths. Do not create a second store or overwrite existing scheduled tasks by following an example literally.

## Validation

Install dependencies once (`npm install`, or `npm ci` for the committed lockfile), then run:

```powershell
npm run check
```

The new guide examples also have a focused check:

```powershell
node --test tests/docs/getting-started.test.mjs
```

Tests and the synthetic demo do not prove that a real worker, a provider account or a production deployment works. Use the evidence levels in [AGENTS.md](AGENTS.md).

## Public showcase

The layout and dashboard are still being finished. The owner asked to prepare the documentation now and build the showcase page afterwards. [Issue #99](https://github.com/netbka/aiworks/issues/99) records that dependency. No final promotional screenshots, site implementation or GitHub Pages deployment are part of this documentation change.
