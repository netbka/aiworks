# Ask an AI assistant to start work

You can type the commands yourself or ask an authorized AI assistant to run them. Both use the same AIWorks authority and state. A prompt does not create credentials, a local connection or deployment permission.

## Choose which kind of AI interaction you need

| Path | What makes the initial call | What it does |
| --- | --- | --- |
| Direct terminal | You run the AIWorks CLI | Register an approved campaign, inspect its state or control it. |
| AIWorks coordinator | You or your external AI run `message` | Queue a read-only planning request. The coordinator returns a proposal, not an executing campaign. |
| Local IDE/terminal agent | A permitted terminal tool runs the same CLI on your PC | Perform the approved setup/start workflow and read actual receipts. |
| ChatGPT with an authorized local bridge | The bridge executes the CLI on the specifically selected paired PC | The same local workflow, with bridge delivery receipts plus AIWorks status. |
| GitHub-only/cloud agent without a local bridge | Repository tools only | Prepare docs/declarations/PRs. It cannot prove it started a process on your Windows PC. |

AIWorks does not expose a public `campaign_start` MCP tool in the inspected release. Its internal repository-reading MCP helper is not a startup API. Use the real CLI through an already-authorized execution tool; do not invent tool names or publish port 4318 to the internet.

## Ask the built-in coordinator for a plan

First configure and enable the [coordinator](CONFIGURATION.md#enable-the-read-only-coordinator), and ensure the supervisor is running. In the runtime checkout:

```powershell
node src/supervisor/cli.mjs message "For example/project, review issue #17 and propose a bounded plan with acceptance checks. Do not implement or release anything." --data C:/Work/aiworks/.local/supervisor
node src/supervisor/cli.mjs messages --data C:/Work/aiworks/.local/supervisor
```

Replace `example/project` and the issue with the actual configured target. The response is a durable message receipt. `received` means queued, `read` means assigned to a coordinator run, and `answered` includes the published response location. None means implementation started. If disabled, unconfigured or blocked, the message may remain received. A provider/account limit may delay processing.

The coordinator's proposal still goes through owner scope approval and the existing declaration/review/registration path in [First project](FIRST_PROJECT.md). It must not be instructed to evade its read-only role. An already-authorized external setup assistant can carry out permitted operational steps; that is not the same agent role as the built-in coordinator.

## Prompt: inspect and plan a new project

Give this to your local coding assistant or ChatGPT with an authorized local execution connection. Replace the fields, but keep the boundaries:

```text
Use AIWorks to prepare work on my project.

Computer: <the specific computer I authorize>
AIWorks source: <absolute path>
AIWorks runtime: <absolute path to the installed runtime>
AIWorks data: <absolute path to the existing data directory>
Project: <absolute project path and GitHub owner/repo when present>
Outcome: <what should be achieved>
Starting material: <issue, PR, local plan or plain instruction>
Acceptance: <how we will know the result is correct>

First read AIWorks AGENTS.md and docs/guides/AI_ASSISTED_START.md,
the installed version's runbook, and this project's rules. Verify the
computer, runtime revision, data directory, project identity, configured
providers and existing work before creating anything. Do not change
someone else's checkout, start a duplicate campaign or read secrets.

Prepare a bounded plan with acceptance checks and identify any existing
approved campaign we should continue. Use the read-only coordinator when
it is available; a coordinator message is planning, not execution.

Do not implement the project in this chat. Do not claim an unsupported
local-folder or UI startup route works. Explain the exact missing
prerequisite instead of creating a fake repository or bypassing a gate.
Show the proposed scope for my approval unless I have already approved
that exact outcome. No merge, deployment or new spending is authorized.
```

A plain folder may be valid input for planning while its execution path is still unavailable. Report the installed release's actual capability instead of converting the user's folder into Git without permission.

## Prompt: start existing approved work

This is the shortest handoff when installation and the reviewed declaration already exist:

```text
On <computer>, use AIWorks runtime <absolute-runtime> and existing data
<absolute-data> to start or resume the already-approved campaign
<campaign-id> for <project>. Its declaration is
<absolute-runtime>/campaigns/<campaign-id>.json.

Read the installed AIWorks rules. Verify machine, project, controller and
store identity, the declaration's recorded authorization, its committed
state in this runtime, and that the runtime revision is merged. Inspect
current campaign status first. Reuse existing work; do not create a new
campaign or restart a healthy controller.

Using the authorized terminal/local bridge, run the existing AIWorks CLI
start command once, then read status. Do not edit the project yourself.
Report the campaign ID, actual readiness, controller code revision,
current task/operation evidence and any blocker or next wakeup. A bridge
receipt, message receipt, queued task or ACTIVE lease alone is not proof
that a model worker is running.

If a tool times out with an uncertain outcome, reconcile the same tool
operation and campaign before retrying. Never bypass approval,
verification, host isolation or provider permissions. No merge or deploy.
```

The actual project-start operation, from the runtime checkout, is:

```powershell
node src/supervisor/cli.mjs start campaigns/my-approved-work.json --data C:/Work/aiworks/.local/supervisor
node src/supervisor/cli.mjs status my-approved-work --data C:/Work/aiworks/.local/supervisor
```

For the owner's existing HomePc installation, use its actual paths rather than the new-install examples:

```powershell
Set-Location D:/Git/aiworks/.local/runtime
node src/supervisor/cli.mjs start campaigns/my-approved-work.json --data D:/Git/aiworks/.local/supervisor
node src/supervisor/cli.mjs status my-approved-work --data D:/Git/aiworks/.local/supervisor
```

`my-approved-work` is a placeholder, not a campaign shipped by this guide. The owner must supply or approve the real assignment. If the controller is absent, inspect the installed task/process first; the assistant may start the already-authorized service through its documented mechanism, but must not update its code, overwrite configuration, clear a deliberate STOP or reconfigure a live service without the required authority.

## From an approved plan to its first start

An authorized setup assistant can prepare the declaration on an isolated `declare/<id>` branch, run its checks and submit it for review. After its actual merge, it checks whether the installed runtime contains the declaration. If a runtime upgrade is needed, the existing coordinated upgrade procedure applies; merge is not deployment.

The assistant then uses `start` and reads status as above. It should reuse the owner's existing outcome approval; ordinary in-scope operational steps are not a reason to ask for approval repeatedly. New project scope, permissions, release destination or spending still needs the relevant owner authority. Future automated intake should replace the manual handoff only when implemented and enabled, not through a documentation shortcut.

## ChatGPT and Local Commander: the transport handoff

When Local Commander is the approved bridge, the external assistant discovers its live tools rather than hardcoding device IDs:

1. Call `workspace_list`, select the owner's intended online computer and approved workspace.
2. Call `execution_session_open` with the returned `deviceId` and `workspaceGrantId`.
3. Submit one `command_run` child through `command_batch`, using `command: "node"`, an argument array for the absolute AIWorks CLI/start path, and the correct workspace-relative `cwd`. Use fresh operation/execution IDs; keep them for reconciliation. Do not open a shell listener or tunnel the dashboard.
4. Follow `operation_status` and `operation_output` for that same operation. `prepared`, `queued`, or `dispatched: false` is not execution. A pre-acceptance rejection is not an AIWorks task failure. Do not submit another start merely because output is delayed.
5. After confirmed command completion, issue the read-only AIWorks `status` command against the same runtime/data directory and interpret it as described in [First project](FIRST_PROJECT.md#confirm-what-is-actually-happening).
6. Close the execution session when the handoff is complete. The separately running AIWorks supervisor, not this chat or bridge session, owns subsequent work.

Tool schemas can change; the assistant must discover and follow the connected bridge's current contract. The bridge grants access to the selected device; AIWorks still validates its own declaration and project rules. A GitHub connector alone is not a local execution bridge.

## What a useful startup report contains

Return a short evidence-based receipt: selected computer and project, campaign ID, readiness, installed/controller revision, stage and observed operation state, blockers/next wakeup, and a result link only when one exists. Do not paste raw logs, authentication output, tokens or internal task packets into a public issue.

Separate these sentences: "I prepared a plan", "I registered a campaign", "a controller is active", "a worker is running", and "the result was independently verified". Only use each when its corresponding evidence exists.
