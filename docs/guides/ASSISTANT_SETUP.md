# Technical instructions for the setup assistant

For an execution-capable AI assistant, not the beginner. Users start with [the short guide](AI_ASSISTED_START.md). Do the permitted technical work rather than asking them to fill in runtime paths, campaign IDs or configuration fields you can resolve yourself.

**Source baseline:** the trusted main of the installed AIWorks source, not a fixed date. Check the actual installed revision against the trusted main and read the current contracts before acting. These instructions describe an AI-assisted use of existing tools, not a newly implemented installer or a promise of universal client compatibility.

## 1. Establish access and scope

Read [AGENTS.md](../../AGENTS.md) and its engineering reading list, [manual installation](MANUAL_INSTALLATION.md), [configuration](CONFIGURATION.md), [the command reference](CLI_REFERENCE.md) and the selected project's rules. Follow the actual permissions and accepted decisions.

Two standing rules apply to all setup work. Builds and checks run on this computer: do not create, enable, dispatch or rerun GitHub Actions (free or self-hosted) and do not use any paid GitHub feature, package or storage. If a step seems to need one, report that requirement and use a local alternative. Every Windows command you run yourself must be a hidden, captured child process (no console window, no shell, stdout, stderr and exit code recorded); use the existing hidden launch helpers and the documented hidden scheduled tasks rather than opening foreground terminals.

Determine the specific authorized computer and whether your tool can execute there. Codex, Claude Code, Cursor Agent or Gemini CLI can be the external setup client when that session has local command/file access. A GitHub-only or cloud session without an authorized bridge can prepare files but cannot start a Windows process on the owner's PC.

Inspect the installation locations and task actions relevant to this project. Do not search unrelated private directories or secret stores. Discover existing source/runtime/data paths rather than making the user repeat them. Ask for a project folder only when the current workspace and permitted reads cannot identify it. Do not inspect .env contents or print credentials.

AIWorks does not expose a public `campaign_start` MCP tool in the inspected release. Do not invent an npm installer, `aiworks start-project` command or Gemini worker adapter. Gemini CLI can run setup commands as an external assistant; it is not a built-in AIWorks task executor. Follow the installed adapter's actual host/role compatibility for every worker.

## 2. Choose demo or real setup

For a demo request, obtain the permitted source, install its locked dependencies and run the existing synthetic review fixture as described in the manual. Use its disposable state and port 4319, never the live state/port. Explain that its projects, costs and worker states are synthetic. Do not connect accounts or dispatch a campaign. Keep track of the process you started and provide its exact local address.

For real work, verify source access, supported native Windows execution, Node with built-in SQLite, Git and GitHub CLI, authenticated compatible workers, target identity and an approved governance checkout. Install missing software only within the user's authorization and using the vendor's supported method. Package scripts are executable code; do not run arbitrary untrusted dependencies under the guise of setup.

For a new installation, run `npm run setup:local` to create the bundled governance starter under ignored `.local/governance`. Follow its README to register the owner's actual approved project locally; no maintainer-private resource is needed. Preserve an existing approved governance directory. Do not use tests/fixtures/governance for real work, forge a registry entry or remove an admission gate. Local-folder connection and execution are distinct capabilities; check the installed version. Never silently initialize Git in an owner's plain folder or invent a GitHub identity.

The short setup prompt allows preparation and startup, not project implementation, runtime replacement, purchases or expanded permissions. Login/MFA, access grants and genuinely new authority remain with the owner. Reuse existing grants rather than repeatedly asking for already-approved scope. No default Run Everything, bypassPermissions or sandbox weakening is part of this guide.

## 3. Configure or reuse the installation

An existing healthy runtime and store must be reused. Inspect them before creating anything. A missing campaign in one database does not justify a second database. For a new installation, use the manual's separation of source, reviewed pinned runtime, state, governance and task worktrees. Fill in the actual non-secret configuration yourself using the inert examples; never register an example unchanged.

Keep native executable paths and Git on PATH as required by the real code. A CLI version check is not proof of role/auth readiness. The built-in coordinator requires Claude even when an external Codex, Cursor or Gemini client performs setup. Do not silently enable optional scheduling, model routing, release or notification features.

If an installed runtime must change, coordinate its existing upgrade procedure with the actual operator. Do not move its HEAD, clear a deliberate STOP, overwrite fixed-name scheduled tasks or reinstall dependencies while work is active. Starting an already-authorized stopped service is different from upgrading/reconfiguring it. The user's onboarding request is not blanket production authority.

Run the controller and local dashboard through the approved hidden scheduled tasks or the documented foreground mechanism. Reuse the existing tasks and the same actual data/governance paths. Confirm readiness and report the exact local URL. If something you started must stay running, say so; do not imply that closing a terminal or putting the PC to sleep leaves work running.

## 4. Plan, approve and start

`serve` runs the controller. `message` queues a read-only planning request. `start` registers, amends or resumes approved work. These are not interchangeable.

The built-in coordinator is optional and read-only. With it configured and enabled, an external assistant can submit a plan request and inspect receipts from the runtime checkout:

```powershell
node src/supervisor/cli.mjs message "Review the configured project's task and propose a short plan. Do not implement or release." --data C:/Work/aiworks/.local/supervisor
node src/supervisor/cli.mjs messages --data C:/Work/aiworks/.local/supervisor
```

Replace the example data path and request with actual approved values. Received/read/answered receipts and the reportTo issue describe planning, not dispatch. A disabled coordinator stores a request without processing it. Do not ask it to grant itself write access.

Show the user the outcome, material steps, checks and changes in plain language. After their scope approval, perform the permitted registration steps yourself. Do not implement the project directly in the setup chat. Check existing assignments before creating one.

For a new assignment, write the actual approved declaration as a private file in the installation's git-ignored `.local/campaigns/` folder and validate it. Never commit or publish it. The runtime code must be merged into the trusted main (AW-005): `origin/main` where the repository is trusted through its remote, or the local main when AIWorks trusts local main (`node src/supervisor/cli.mjs trusted-main` prints it). The declaration need not be merged. Reuse an existing approval faithfully; do not invent one. Runtime updates have their own procedure: only the exact reviewed trusted-main revision is installed, and only by the operator through the [upgrade procedure](../SUPERVISOR.md#upgrade). Do not submit private task contents to a public upstream as an onboarding shortcut.

For an existing approved assignment, resolve its ID and file from authorized project context; do not require a novice to know them. From the actual runtime checkout:

```powershell
node src/supervisor/cli.mjs status my-approved-work --data C:/Work/aiworks/.local/supervisor
node src/supervisor/cli.mjs start .local/campaigns/my-approved-work.json --data C:/Work/aiworks/.local/supervisor
node src/supervisor/cli.mjs status my-approved-work --data C:/Work/aiworks/.local/supervisor
```

The names and paths are placeholders. Use the installation's actual values. A successful start response alone does not prove work has begun. Inspect readiness, controller revision, task and operation evidence. ACTIVE means a live controller lease, not necessarily an executing worker. Distinguish a plan, registered work, working/waiting state, verified result and publication. Source acceptance, a local merge, runtime installation and release are separate facts, and merge and deployment are not part of this setup flow.

## 5. Optional handoff through a local command bridge

A web chat session can reach this PC only through a local command bridge that the owner already authorized, such as an MCP connector that runs approved commands on a paired device. Discover that bridge's tool schemas and follow its current contract:

1. Select the intended online device and approved workspace. Never reuse a device or workspace identifier from another installation or an earlier conversation.
2. Submit the actual node CLI command as an argument array, with correct paths and a workspace-relative working directory. Keep the operation identifiers the bridge returns.
3. Follow that same operation until it completes. A prepared, queued or not-yet-dispatched command has not run. Reconcile an uncertain outcome before another write; never create a second campaign just because the first response was delayed.
4. Read AIWorks status against the same runtime and store after the command completed. Bridge acceptance is not AIWorks readiness.
5. Close the bridge session after the handoff. Only an independently running supervisor continues beyond that session.

Do not open a listener, tunnel the dashboard or expose port 4318 as a public website. A bridge rejection before acceptance is not an AIWorks task failure. Do not route around a permission denial.

## 6. Report to the person, not to another engineer

The owner controls direction, decisions, planning, stopping and resources; AIWorks does the execution and routine investigation. Use the existing owner controls (pause, resume, stop and the decisions the dashboard shows) rather than inventing a gate or asking for what you can resolve. Never present a stopped or unassigned repair as running.

Lead with one sentence: ready for the first task, the task is running, it is waiting, or a named step needs the owner. Give the local dashboard or actual result link when it exists. Explain the next action, not the whole internal contract.

Describe business outcomes and the action the person can take. Keep exact revisions, campaign/operation identifiers, commands and test evidence in private evidence for diagnostics; do not put hashes, internal identifiers or commands in the beginner's reply, and do not alter text the owner entered. Report unknowns honestly. Never paste raw worker logs, private task packets or authentication output into the conversation or a public issue.

Refer to [troubleshooting](TROUBLESHOOTING.md) and the [supervisor runbook](../SUPERVISOR.md) rather than deleting stores, clearing counters, force-pushing verified branches or killing unrelated processes. Website work remains deferred under [#99](https://github.com/netbka/aiworks/issues/99).
