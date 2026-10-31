# Configure a local installation

The supervisor reads `<data-directory>/config.json`. See the complete inert [config example](examples/config.example.json). JSON does not allow comments. Validate the edited file without printing its contents:

```powershell
node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); console.log('JSON syntax valid');" C:/Work/aiworks/.local/supervisor/config.json
```

This checks JSON syntax only, not accounts, paths or execution readiness.

## Paths and project registration

| Setting | Meaning |
| --- | --- |
| `governanceRoot` | Absolute path to the approved, read-only governance checkout. Used for inherited rules and registered project identity. |
| `repositories` | Map of the target's actual GitHub `owner/name` to its local checkout and isolated worktree root. Listing it here does not create governance registration. |
| `repositories[...].path` | Existing target checkout. This is not the AIWorks source or data directory. |
| `repositories[...].worktreeRoot` | Separate directory where supervisor-owned task worktrees are created. Never another person's active checkout. |
| `commands` | Arrays containing absolute native executable paths and, where supported, fixed arguments. No credentials. |
| `coordinator` | Optional read-only planning configuration. It is disabled in the example. |

AIWorks source, the pinned runtime, supervisor state and target project files are different locations. Do not point `--data` to the project directory or create a new database because an old path returns `CAMPAIGN_NOT_FOUND`.

Pass `--data` explicitly in both terminals. Alternatively set `AIWORKS_DATA` to the same absolute directory. If both are present and disagree, status rejects the ambiguous request with `DATA_DIR_MISMATCH`. `--governance` selects the governance checkout for that invocation; setting `governanceRoot` consistently in config avoids registration and service processes using different rule copies.

## Worker commands

The simplest first run uses a compatible native Claude Code executable. The bundled coordinator also uses Claude; configuring Codex alone does not provide a Claude coordinator.

```powershell
Get-Command claude.exe, gh.exe, git.exe -ErrorAction SilentlyContinue | Select-Object Name, Source
claude --version
gh --version
gh auth status
```

Version output proves the binary exists, not that a model call or its required role can run. Authenticate interactively through the provider's supported flow under the Windows account that runs AIWorks. Do not copy session tokens between users, machines, configuration files or CI.

The runtime spawns native executables; a `.cmd` wrapper that works in an interactive shell may not work here. Keep the real Git executable on PATH as well: provenance checks intentionally do not use `commands.git` to establish that source is merged.

Claude, Codex, Cursor and AGY have different role and host requirements. The [executor runbook](../SUPERVISOR.md#8-ordered-cli-execution) is the compatibility authority. Cursor appearing in an example provider chain does not make its native sandbox available on this Windows host. AGY is a browser-check adapter, not the generic implementation worker. Do not disable a sandbox or bypass a permission refusal to make a sample run succeed.

## Enable the read-only coordinator

The example has `coordinator.enabled: false`. Once its dependencies are ready, set it to `true` and replace:

- `repositories`: the approved repositories the coordinator may inspect;
- `reportTo`: an existing issue you control, such as `YOUR_ACCOUNT/YOUR_PROJECT#17`, where the supervisor may publish the answer;
- `model`: a model supported by your installed Claude CLI/account;
- `sourceRepo`, `runtimeRoot`, `worktreeRoot`: your actual AIWorks source, runtime and separate coordinator-worktree parent.

The example's `permissionMode` is `dontAsk`, the only coordinator mode accepted. It means unallowed coordinator tools are refused, not that the agent has unrestricted access. No credential is stored in this object.

Sending `message` before enabling/configuring the coordinator still stores a receipt but does not cause it to be read. `messages` shows whether configuration is valid and whether a request is received, read or answered. The supervisor must be running from merged code to process it. Answers may be posted to GitHub, so do not put private customer data or secrets in messages.

## Optional features and budgets

Do not enable every optional feature to follow the quickstart. CI repair, integration repair, notification delivery and release controls have separate contracts and rollout state in [the runbook](../SUPERVISOR.md) and [Status](../STATUS.md). The sections below cover the settings that are easy to confuse. A default in source is not evidence that an installation has a feature on; check your own `config.json` and status.

### Scheduler

The scheduler is off unless `scheduler.enabled` is exactly `true`; an absent key, `false` or any other value leaves it off, and each campaign then runs one worker at a time. Switching it on lets different campaigns run side by side, never two steps of one campaign unless that campaign declares `limits.slots`. Other `scheduler` fields are optional host-safety settings:

| Field | Meaning |
| --- | --- |
| `scheduler.enabled` | `true` turns on admission by capacity, write domains and account waits. |
| `scheduler.maxWorkers` | Whole number 1 to 32: most worker operations at once on this host. Without it the ceiling is `clamp(floor(cores / 4), 1, 4)`. It only delays work; it is not a run, cost or budget limit. |
| `scheduler.pressure` | Optional overrides of the memory, CPU, disk, port, Docker and late-heartbeat thresholds (`maxPortShare` 0.5 of the TCP or UDP ephemeral ports, `maxContainers` 12 running containers, `probeStaleMs`). A value that is not a positive number keeps its default. Pressure only refuses new admission. Ports and Docker are read by `serve` once a minute, outside the admission pass; Docker only when `docker.gate` is on. |
| `docker.gate` | Windows, off by default. **Not ready to switch on:** the gate's named pipe cannot pass the end of a client's input, so `docker exec -i` or `docker run -i` with redirected input hangs through it. When on, `serve` starts the Docker gate (`cli.mjs docker-gate`, log in `<data>/docker-gate.log`) and sets `DOCKER_HOST` to its named pipe for every process it starts. The gate passes every Docker request on unchanged, except that a container start of a new Compose project, a Testcontainers session or a loose container, and a classic-builder image build (`POST /build`; BuildKit builds are not held), wait while `docker.slots` of them already run, for at most 10 minutes. Workers are never held: only their Docker work waits. The gate finds the engine through `docker.engine` (a `npipe://` address), an operator `DOCKER_HOST` naming a pipe, or the current Docker context; any other `DOCKER_HOST` keeps it off. A gate that does not start leaves Docker direct and is logged. |
| `docker.slots` | Docker Compose projects (or loose containers and builds) that may run at once on the computer, 1 to 16, default 2. Containers of a project that already runs never wait. |
| `docker.cleanup` | Optional list of repositories (`["owner/repo"]`) whose Docker Compose stacks AIWorks takes down, with their volumes, when no open run or running refresh gate uses them: every 10 minutes and after each run of that repository. Only stacks whose working directory is inside the repository's worktree root are touched, found by Docker Compose's own labels; AIWorks runs only `commands.docker` (default `docker`), never a script from a worktree, and leaves alone a project that also has a container outside the worktree root. |
| `workerJob` | Optional settings of each worker's Windows job: `memoryBytes` (committed memory of the whole worker tree, default a quarter of the computer's memory, at least 4 GiB), `processes` (live processes, default 512) and `priority` (`"belownormal"`, the default, or `"normal"`), which every process of the worker starts at. `0` switches a cap off. A worker that reaches a cap fails its own allocation or process start. |
| `workerCpu` | Optional worker CPU monitor, on by default on Windows: `{ "enabled": true, "high": 0.85, "low": 0.6, "minShare": 0.1, "intervalMs": 30000 }`. Every interval it reads each worker job's CPU time, which covers the worker and everything it started. While the computer is more than `high` busy, the worker using the most CPU (at least `minShare` of the computer) drops to idle priority, one per interval; under `low` every lowered worker returns to its starting priority. Nothing is stopped. Each change is journalled (`worker-cpu-lowered`, `worker-cpu-restored`). Docker containers run outside worker jobs; `docker.slots` limits them. |
| `providerAccounts` | Optional map from an executor kind to an account name, so waits and limits are tracked per account. A missing or malformed name falls back to the kind. This names an account for scheduling; it holds no credential and is not a budget. |

Follow the [scheduler rollout procedure](../SUPERVISOR.md#scheduler-rehearsal-switch-on-and-switch-back-run10) to switch it on or back; merging code switches nothing.

### Model routing

Routing has no global switch in `config.json`. A campaign uses it only when its private declaration carries `routing` with `mode: "auto"`, candidate models for providers the declaration already authorizes, and optional sensitive paths and a pin. Without `routing`, steps run on the declared executor order. Because `routing` is part of the scope digest, an existing campaign changes it only through an amendment with a higher authorization version. Candidate models and tiers are the owner's authorization; an account's plan (flat or pay-per-use) and its budget are separate facts and are not inferred from a model name. See [the routing runbook](../SUPERVISOR.md#model-routing-cohort-switch-on-compare-and-switch-back-mod7).

### Local trust of AIWorks's own main

`selfHosting` is absent by default, which means `origin` is trusted. Only a valid block names AIWorks's own repository and may set `trustedMain` to `"local"`; a malformed block turns self-hosting off. Local trust applies to that one repository only, never to a connected project. Optional `selfHosting.backup` is off unless its `enabled` is `true`. Local trust does not remove the exact-head verification, the merge gate or branch protection.

### Project connections

Projects are connected from the dashboard, which reads a GitHub project, copies a chosen branch of a local Git project into AIWorks's managed mirror, or snapshots a plain folder; the owner's folder is not changed. Connecting does not write `config.json`. If a `repositories` entry and the connected project point to different places, connect reports `CONFIG_CONFLICT`; remove one of them rather than letting AIWorks guess. Standing project settings (protected areas, notes, optional budgets, acceptance mode) are stored by the supervisor, can only add protection and limits, and do not grant release or widen a declaration.

### Previews

A checked version's preview of a page runs under existing containment. A project's own server is started only where `previews.servers` names it, keyed by the project's repository or local project id:

```json
"previews": {
  "servers": { "example/project": { "script": "scripts/preview.mjs", "ready": "/" } },
  "packageCache": "C:/Work/npm-cache"
}
```

Only `script` (a repository-relative `.mjs`, `.cjs` or `.js` path) and optional `ready` (the page to open) are accepted; any other field makes the entry invalid and nothing starts. Without an entry the server preview stays unavailable. `previews.packageCache` is an optional absolute folder holding npm's cache, from which locked packages are prepared and hash-checked; if unset, npm's own cache location is used, and a relative path means nothing is prepared.

### Notifications

Telegram alerts take only references into your own secret store for the bot credential and the chat, never their values ([runbook section 10](../SUPERVISOR.md#10-owner-intervention-core)). Recording needs `ownerIntervention.enabled`; sending also needs `ownerIntervention.deliver` and a ready transport.

### Budgets

The report example includes an **illustrative, explicit** run/retry budget for someone choosing a bounded first experiment. It is not a new product-wide default or a price quote. The product's default does not impose campaign run/cost ceilings. A dollar ceiling additionally requires the documented handling for unreported cost; a missing receipt is never free usage. Verify eligibility and compatibility before changing limits or providers on an existing campaign.

No configuration field in this guide grants Auto Release. Keep the project in Review only unless its separately accepted release workflow and destination-specific authorization actually permit otherwise.
