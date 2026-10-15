# Install AIWorks locally

## Prerequisites

Use a Windows machine for real worker execution. Windows process containment is part of the current runtime. A Linux CI result or a dashboard that renders on another OS does not establish supported worker execution there.

Install [Node.js](https://nodejs.org/en/download), [Git for Windows](https://git-scm.com/download/win), and, for real GitHub work, [GitHub CLI](https://cli.github.com/). Use a maintained Node 22.x build no older than 22.18 for these instructions; `package.json` declares the lower minimum 22.5, but older 22.x builds can require an experimental SQLite flag. Use Git 2.38 or newer for the integration-repair functionality described in the runbook. Verify the actual binaries:

```powershell
node --version
npm --version
git --version
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.close(); console.log('SQLite ready');"
```

For a real run, install and sign in to at least one supported worker CLI under the same Windows account that will run AIWorks. Start with the native Claude Code installation described by [its vendor](https://code.claude.com/docs/en/setup). Follow [the official Codex instructions](https://developers.openai.com/codex/cli/) for optional Codex setup. Do not infer adapter/role compatibility from vendor support alone; see [provider configuration](CONFIGURATION.md#worker-commands).

AI-provider usage can consume your subscription allowance or API credits. No provider subscription, API credit or paid upgrade is included in this repository.

## Get the source

These paths are examples for a **new** installation. Do not reuse them over an existing checkout, data directory or scheduled task. The repository is still private during preparation, so cloning requires repository access.

```powershell
# Choose an existing parent directory and a new destination.
Set-Location C:/Work
git clone https://github.com/netbka/aiworks.git
Set-Location C:/Work/aiworks
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
```

Use the Git authentication method approved for your account. For GitHub CLI's browser login, run `gh auth login --web`, then `gh auth status`; never paste a token into a guide, campaign or issue. The CLI's [authentication manual](https://cli.github.com/manual/gh_auth_login) explains credential storage and fallback behavior.

## Try the demo without worker credentials

From the source checkout:

```powershell
node tests/dashboard/fixtures/review-store.mjs --port 4319
```

Open `http://127.0.0.1:4319` on this computer. Keep the terminal open. The fixture creates disposable SQLite data and local Git repositories with made-up projects. It uses no model, provider credential or real project. Its displayed workers, costs and states are synthetic. Sending a message there does not demonstrate a working coordinator.

Other fixture states:

```powershell
node tests/dashboard/fixtures/review-store.mjs --port 4319 --store empty
node tests/dashboard/fixtures/review-store.mjs --port 4319 --store unreadable
```

Run one instance at a time and stop the previous instance with Ctrl+C. Some fixture states change with elapsed time. This is a development preview, not the finished public layout or an acceptance result. Never use the fixture's `--dir` option with live state; port 4318 is reserved for the real dashboard. Fixture behavior may change while the dashboard work continues.

## Install for real project work

### 1. Check access before configuring anything

You need all of the following: permission to use AIWorks source; an approved governance checkout; a target project's actual registered identity/rules; a clean local GitHub-backed project checkout; GitHub access for reading the relevant issues and publishing the authorized result; and a compatible, authenticated worker CLI.

The generic public governance bundle is not supplied by this guide. Without access, the demo still helps you explore, but real project startup is not ready for you. Do not substitute `tests/fixtures/governance`, fake a registry record or remove the admission check. [The release checklist](../publication/RELEASE_CHECKLIST.md) tracks removing this private-setup dependency through the proper product work.

### 2. Keep source, runtime and state separate

For a new installation only:

```powershell
$Root = 'C:/Work/aiworks'
$Runtime = "$Root/.local/runtime"
$Data = "$Root/.local/supervisor"
$Governance = "$Root/.local/governance"
New-Item -ItemType Directory -Force "$Root/.local", $Data | Out-Null

git -C $Root fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Cannot fetch approved source' }
$Revision = (git -C $Root rev-parse origin/main).Trim()
git -C $Root worktree add --detach $Runtime $Revision
if ($LASTEXITCODE -ne 0) { throw 'Cannot create runtime checkout; do not overwrite an existing runtime' }
Set-Location $Runtime
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Runtime dependency installation failed' }
```

Use an independently reviewed merged revision approved for installation, not an arbitrary new main tip. The commands select the fetched tip; verify its review/installation evidence before executing the `worktree add` step. An existing runtime must instead follow [the upgrade procedure](../SUPERVISOR.md#upgrade), not a pull, checkout or reinstall while workers are running.

Clone the governance repository **only when your account is authorized to access it**:

```powershell
git clone https://github.com/netbka/engineering-platform.git $Governance
```

Keep this checkout read-only to AIWorks. Target project registration/rule changes use the governance provider's own workflow, not writes into this clone.

### 3. Create your configuration

Copy the inert example into the new data directory:

```powershell
Copy-Item "$Root/docs/guides/examples/config.example.json" "$Data/config.json"
```

Replace every sample path, repository and issue with your real approved values. The example enables no coordinator; it cannot work unchanged. See [Configuration](CONFIGURATION.md). Use native executable paths, keep Git on PATH, and authenticate your tools normally. Do not place credentials in `config.json`.

Before the first run, inspect the target with `git -C <project-path> status --short --branch` and confirm its remote identity locally. Never print a credential-bearing remote URL into a shared report. Do not clean, reset or switch a project someone else is editing.

### 4. Start the controller and dashboard

From the runtime checkout, in one terminal:

```powershell
node src/supervisor/cli.mjs serve --data C:/Work/aiworks/.local/supervisor --governance C:/Work/aiworks/.local/governance
```

In a second terminal, also in the runtime checkout:

```powershell
npm run dashboard -- --data C:/Work/aiworks/.local/supervisor --governance C:/Work/aiworks/.local/governance
```

Open `http://127.0.0.1:4318` on the same machine. Both processes use the same data directory. The controller initializes its store; the dashboard does not assign work merely by opening. Leave both terminals running for this foreground setup. Continue with [your first project](FIRST_PROJECT.md).

### 5. Optional automatic startup on Windows

Only after the foreground setup is working, consider the existing per-user task installers. They use fixed names, `AIWorks Supervisor` and `AIWorks Dashboard`; do not overwrite another installation's tasks. Inspect existing task actions first:

```powershell
Get-ScheduledTask -TaskName 'AIWorks Supervisor','AIWorks Dashboard' -ErrorAction SilentlyContinue | Select-Object TaskName, Actions
```

For a new installation with those names unused, first stop the foreground processes when no work is in flight. From the runtime checkout:

```powershell
powershell -NoProfile -File scripts/supervisor/install-windows-task.ps1 -Checkout C:/Work/aiworks/.local/runtime -DataDir C:/Work/aiworks/.local/supervisor
powershell -NoProfile -File scripts/supervisor/install-dashboard-task.ps1 -Checkout C:/Work/aiworks/.local/runtime -DataDir C:/Work/aiworks/.local/supervisor
```

Follow [the Windows runtime runbook](../SUPERVISOR.md#6-running-on-homepc) for validation and recovery. These are local per-user tasks, not a hosted 24/7 service; a sleeping or offline PC does not execute work. Do not run a foreground controller as a second unsupervised instance of the same installation.

## Stop or update safely

Pause affected campaigns and reconcile their in-flight operations before an update. `stop` writes the data directory's `STOP` marker so the controller/keeper stops and stays stopped. It is not proof that every already-dispatched worker has terminated. Do not delete the store, its WAL files or run directories to recover. Use [Troubleshooting](TROUBLESHOOTING.md) and the canonical [upgrade procedure](../SUPERVISOR.md#upgrade).

No live campaign, service, scheduled task or provider was changed by publishing these instructions.
