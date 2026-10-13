# AIWorks

AIWorks keeps explicitly authorized AI work moving on a local machine. A persistent supervisor assigns bounded tasks to headless workers, verifies each result in a separate fresh session, and opens pull requests or publishes reports. A read-only coordinator plans work, and a local dashboard shows progress and blockers.

Supported worker adapters include Claude, Codex, Cursor and browser acceptance workers. Provider fallback never bypasses permission denials or verification. The supervisor never merges, deploys or changes provider resources.

## Source and installation data

This tree contains reusable code and synthetic examples. Campaigns, connected-project inventories, configuration, authorization records, state, logs and run artifacts are private installation data. Keep them in ignored directories or outside the checkout. Never add them to a public commit.

`campaigns/` and `.local/` are ignored. Removing a file from a current commit does not remove it from earlier history. See [publication preparation](docs/PUBLICATION.md) before making an existing repository public.

## Start here

- [Product constitution](docs/PRODUCT_CONSTITUTION.md)
- [Agent rules](AGENTS.md)
- [Supervisor runbook](docs/SUPERVISOR.md)
- [Dashboard](docs/OPERATIONS_DASHBOARD.md)
- [Decisions](docs/DECISIONS.md)
- [Worker context lifecycle](docs/WORKER_CONTEXT_LIFECYCLE.md)
- [Development status](docs/STATUS.md)

## Run it

Runtime execution requires Windows, Node 22.5 or newer, an authenticated GitHub CLI and the chosen worker CLIs. Unsupported process-containment environments fail closed. Unit tests can also run in CI; platform-specific checks are identified separately.

```sh
npm install
```

Create `.local/supervisor/config.json` with absolute paths appropriate to your machine. These names and paths are fictional examples:

```json
{
  "governanceRoot": "C:/work/aiworks/.local/governance",
  "repositories": {
    "example-org/sampleapp": {
      "path": "C:/work/sampleapp",
      "worktreeRoot": "C:/work/aiworks/.local/worktrees/sampleapp"
    }
  },
  "commands": {
    "claude": ["C:/tools/claude.exe"],
    "codex": ["C:/tools/codex.exe"],
    "gh": ["C:/tools/gh.exe"]
  }
}
```

The governance directory provides `registry/projects`, `policies/catalog.json` and the project-contract schema. AIWorks reads it and does not own or publish it. New campaigns must target a registered project. Missing or invalid governance stops work that needs it.

Optional `coordinator` and `ownerIntervention` configuration are described in the runbook. No credentials go into `config.json`.

Create your private campaign under `.local/campaigns/` using the contract in `src/supervisor/campaign.mjs`. The files in `tests/fixtures/campaigns/` are synthetic validation examples, not operational assignments.

```sh
node src/supervisor/cli.mjs start .local/campaigns/work.json --data .local/supervisor
node src/supervisor/cli.mjs keep --data .local/supervisor
node src/supervisor/cli.mjs status <campaignId> --data .local/supervisor
npm run dashboard -- --data .local/supervisor
```

Registration and execution require merged runtime code. Private campaign declarations are read locally and stored in the private SQLite database. They are never required in Git. `AIWORKS_DATA` may replace `--data`. The dashboard listens at `http://127.0.0.1:4318`.

## Layout

| Path | Purpose |
| --- | --- |
| `src/supervisor/` | Controller, CLI, state store, process containment and adapters |
| `src/dashboard/` | Local dashboard server and UI |
| `scripts/lib/worker-context.mjs` | Packet, context and lease helpers |
| `registry/worker-context-policy.json` | Public worker-context defaults |
| `schemas/` | Reusable schemas |
| `tests/fixtures/` | Synthetic campaign and governance fixtures |
| `.local/` | Ignored private runtime, state, worktrees and governance |
| `campaigns/` | Optional ignored private declarations |

## Validation

```sh
npm run check
```

This validates public commit scope, synthetic declarations and the test suite. It does not read an installation's private campaigns. Run the installation and upgrade scripts only as an explicit operator maintenance action; see the runbook.
