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

Do not enable every optional feature to follow the quickstart. Scheduler, model routing, CI repair, integration repair, notification delivery and release controls have separate contracts and rollout state in [the runbook](../SUPERVISOR.md) and [Status](../STATUS.md).

The report example includes an **illustrative, explicit** run/retry budget for someone choosing a bounded first experiment. It is not a new product-wide default or a price quote. The product's default does not impose campaign run/cost ceilings. A dollar ceiling additionally requires the documented handling for unreported cost; a missing receipt is never free usage. Verify eligibility and compatibility before changing limits or providers on an existing campaign.

No configuration field in this guide grants Auto Release. Keep the project in Review only unless its separately accepted release workflow and destination-specific authorization actually permit otherwise.
