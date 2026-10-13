# AIWorks

AIWorks is the owner's AI delivery machine. It runs on the owner's PC and keeps registered work moving without the owner prompting each agent.

- A **supervisor** runs the campaigns the owner registered. It gives each task to a headless AI worker: Claude, Codex or Cursor, or AGY for checks in a real browser. A separate fresh session checks the result. Then the supervisor opens a pull request or posts a report.
- It **waits out** provider limits and restarts on its own. It stops for the owner only when a real decision is needed.
- A read-only **coordinator** answers the owner's messages and plans work.
- A local **dashboard** at `http://127.0.0.1:4318` shows what needs the owner first, then progress in plain words.

AIWorks never merges, deploys or changes provider resources. Merge and release stay with each project.

**Who it is for.** The owner only.

**Where it stands.** See [docs/STATUS.md](docs/STATUS.md).

## Start here

This is the single reading list; [AGENTS.md](AGENTS.md) points to it.

1. [Product Constitution](docs/PRODUCT_CONSTITUTION.md) - what AIWorks is, for whom, and how success is measured
2. [Status](docs/STATUS.md) - where things stand and what needs the owner
3. [Agent rules](AGENTS.md) - what agents may and may not do here
4. [Decisions](docs/DECISIONS.md) - accepted decisions AW-001 to AW-007
5. [Delivery Supervisor](docs/SUPERVISOR.md) - the runbook: boundary, lifecycle, failures, commands, HomePc layout, upgrades
6. [Operations Dashboard](docs/OPERATIONS_DASHBOARD.md) - what the owner sees and the local access boundary
7. [Worker Context Lifecycle](docs/WORKER_CONTEXT_LIFECYCLE.md) - task packets, leases and fresh sessions
8. [Glossary](docs/GLOSSARY.md) - terms and IDs

Portfolio rules that AIWorks follows live in [Engineering Platform](https://github.com/netbka/engineering-platform):

- [Constitution](https://github.com/netbka/engineering-platform/blob/main/docs/CONSTITUTION.md)
- [Agent Operating Model](https://github.com/netbka/engineering-platform/blob/main/docs/AGENT_OPERATING_MODEL.md)
- [Continuation](https://github.com/netbka/engineering-platform/blob/main/docs/CONTINUATION.md)
- [Owner Intervention](https://github.com/netbka/engineering-platform/blob/main/docs/OWNER_INTERVENTION.md)

## Layout

| Path | What it holds |
| --- | --- |
| `src/supervisor/` | The supervisor: CLI, controller, SQLite store, runner, Windows process containment, coordinator, owner-intervention core, browser wrapper |
| `src/supervisor/adapters/` | Executors for the worker CLIs, plus Git and GitHub adapters |
| `src/dashboard/` | The operations dashboard: server, owner view and page |
| `src/shared/` | Shared helpers |
| `campaigns/` | Campaign declarations, one JSON file per campaign |
| `scripts/lib/worker-context.mjs` | Worker-context helpers: packet validation, context planning, lease checks |
| `registry/worker-context-policy.json` | Worker-context policy defaults |
| `schemas/` | Schemas for the worker-context policy and the worker task packet |
| `scripts/check-campaigns.mjs` | Parses every campaign declaration |
| `scripts/supervisor/install-windows-task.ps1` | Registers the supervisor as a Windows task: at logon, and every 5 minutes if it stopped |
| `scripts/supervisor/install-dashboard-task.ps1` | Registers the dashboard as a Windows task: at logon, and every 5 minutes if it stopped |
| `scripts/supervisor/deploy.ps1` | Deploys a reviewed commit to `.local/runtime` and refreshes the governance checkout |
| `tests/` | Supervisor, dashboard and worker-context tests; `tests/fixtures/governance/` is a small governance checkout for tests |

## Run it

Requirements: Windows, Node 22.5 or newer, an authenticated `gh` CLI, and the worker CLIs installed and logged in.

```sh
npm install
```

### Configure

The supervisor's data directory holds `config.json`. Its shape, with example paths:

```json
{
  "governanceRoot": "D:/Git/aiworks/.local/governance",
  "repositories": {
    "netbka/Dyk": { "path": "D:/Git/Dyk", "worktreeRoot": "D:/Git/aiworks/.local/worktrees/Dyk" }
  },
  "commands": {
    "claude": ["C:/path/to/claude.exe"],
    "codex": ["C:/path/to/codex.exe"],
    "gh": ["C:/path/to/gh.exe"]
  },
  "coordinator": {
    "repositories": ["netbka/aiworks", "netbka/engineering-platform", "netbka/Dyk"],
    "model": "opus", "timeoutMinutes": 60
  }
}
```

- `governanceRoot` is the governance checkout: a plain clone of `netbka/engineering-platform` main. AIWorks reads the project registry, policies and schemas from it and never writes to it. Without it, anything that needs it fails closed ([SUPERVISOR.md §6](docs/SUPERVISOR.md#governance-checkout)).
- `repositories` maps each target repository to its local checkout and a worktree root.
- `commands` gives each tool as an absolute native executable in an array. `cursor`, `agy` and `chrome` are optional ([SUPERVISOR.md §8 and §11](docs/SUPERVISOR.md#8-ordered-cli-execution)).
- `coordinator` is optional; without it, owner messages are stored but not read ([SUPERVISOR.md §9](docs/SUPERVISOR.md#9-owner-messages-and-the-coordinator)).
- Coordinator plans and replies stay in the local dashboard. Planning never creates GitHub issues, PRs or comments.
- `ownerIntervention` is optional and off by default ([SUPERVISOR.md §10](docs/SUPERVISOR.md#10-owner-intervention-core)).

No credentials go into `config.json`.

### Supervisor

```sh
node src/supervisor/cli.mjs serve --data <dir>     # the controller loop
node src/supervisor/cli.mjs keep --data <dir>      # runs serve and restarts it after any exit
node src/supervisor/cli.mjs start campaigns/<campaign>.json --data <dir>
node src/supervisor/cli.mjs status <campaign> --data <dir>
```

`AIWORKS_DATA` may stand in for `--data`. `start` also accepts `--governance <path>`. Other commands (`pause`, `cancel`, `recheck`, `stop`, `message`, `messages`, `coordinator-clear`) are in [SUPERVISOR.md §5](docs/SUPERVISOR.md#5-commands).

### Dashboard

```sh
npm run dashboard -- --data <dir> --governance <path>
```

Open `http://127.0.0.1:4318`. `--governance` defaults to `governanceRoot` in `config.json`. The dashboard binds to `127.0.0.1` only ([AW-003](docs/DECISIONS.md#aw-003---the-operations-dashboard-is-local-only)).

### Windows tasks

```powershell
powershell -NoProfile -File scripts\supervisor\install-windows-task.ps1 -Checkout D:\Git\aiworks\.local\runtime -DataDir D:\Git\aiworks\.local\supervisor
```

This registers the per-user logon task `AIWorks Supervisor`, which runs `keep` hidden. The dashboard runs as a separate task, `AIWorks Dashboard`, registered by `scripts/supervisor/install-dashboard-task.ps1` with the same arguments.

If either stops, it comes back within 5 minutes: both tasks also start every 5 minutes, and do nothing while they already run. `cli.mjs stop` keeps the supervisor stopped until its STOP file is removed. `keep` writes why it ended to `supervisor.log`. When every controller lease has expired, `status` and the dashboard lead with "supervisor stopped" and the time of the last lease renewal. Details: [SUPERVISOR.md §6](docs/SUPERVISOR.md#6-running-on-homepc).

## HomePc layout

| Path | Purpose |
| --- | --- |
| `D:/Git/aiworks` | Development checkout |
| `D:/Git/aiworks/.local/runtime` | Detached checkout of the reviewed commit that the supervisor and dashboard run from |
| `D:/Git/aiworks/.local/supervisor` | Data directory: `config.json`, the SQLite store, journal, log and run artifacts |
| `D:/Git/aiworks/.local/worktrees/<repo>` | Worktrees the supervisor creates for workers and verifiers, and the coordinator's checkout |
| `D:/Git/aiworks/.local/governance` | Governance checkout of `netbka/engineering-platform` main, read-only to AIWorks |

`.local/` is ignored by Git. The live runtime changes only through the [upgrade procedure](docs/SUPERVISOR.md#upgrade).

## Validation

After changing code, schemas, campaign declarations, fixtures or documentation, run `npm install` once and then `npm run check`.
