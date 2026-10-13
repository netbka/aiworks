# Troubleshooting

Start with the installed revision and the actual data directory. Do not repair an unfamiliar state by creating a second installation.

```powershell
# Read the selected installed runtime's revision.
git -C C:/Work/aiworks/.local/runtime rev-parse HEAD

# Read the existing campaign, using explicit paths.
node C:/Work/aiworks/.local/runtime/src/supervisor/cli.mjs status my-approved-work --data C:/Work/aiworks/.local/supervisor
```

On a task-installed Windows machine, inspect the existing `AIWorks Supervisor` task's Actions before assuming these example locations. The CLI's revision and the controller revision recorded in its lease can differ.

## Setup and startup

| Symptom | Check and safe next action |
| --- | --- |
| Clone denied / repository not found | Confirm repository permission and Git authentication. The preview repository may still be private. Never paste tokens into an issue. |
| `node:sqlite` unavailable | Use a maintained Node 22.x build at least 22.18 for the guide and run its in-memory SQLite probe. Do not install an unrelated SQLite npm package to replace the built-in module. |
| `GOVERNANCE_ROOT_REQUIRED` / `GOVERNANCE_ROOT_INVALID` | Check the selected `governanceRoot` and approved checkout/schema availability. A test fixture is not a production rules bundle. |
| Target is not a registered project | Configuring a repository path is not governance registration. Use the approved Engineering Platform registration workflow. |
| `DECLARATION_NOT_ON_MAIN` | The file must be in this CLI checkout's own campaigns/, committed and unmodified at its HEAD. A file in the source checkout is not the runtime's file. Follow review and runtime upgrade rules. |
| `RUNTIME_NOT_MERGED` / `runtime-not-merged` | Compare the actual runtime revision to its fetched origin/main. An old merged revision is allowed; an unmerged branch is not. Do not bypass provenance or update an active runtime in place. |
| `STORE_NOT_FOUND` | Confirm the installed task's data path. Status is read-only and does not create a new store. Start the legitimate installation's controller only after identifying it. |
| `CAMPAIGN_NOT_FOUND` | Check store and campaign identity. On a first assignment registration may be pending; on an existing assignment a wrong data path is a likely cause. |
| `DATA_DIR_MISMATCH` | Make explicit --data and AIWORKS_DATA agree, or remove the stale shell variable. Do not silently search for another database. |
| `WORK_ALREADY_ASSIGNED` | Inspect the reported owning campaign/task. Reuse or sequence that work; a new ID is not a solution. |
| Provider executable cannot start | Check its actual native executable path, Windows account, installed version and adapter/role eligibility. An interactive .cmd wrapper is not proof of headless support. |
| Port 4318 or 4319 is busy | Identify the process/installation already using it. Do not kill arbitrary node processes. Stop only your own disposable demo or use the documented operating procedure. |

## The agent appears to be waiting

`ACTIVE` describes a controller lease, not a currently working model. Inspect task/operation state, progress time, provider wait and next wakeup. A declared fallback may be unusable for this host or role. Do not remove its sandbox protections.

A known provider limit should be allowed to reset. `recheck` can clear waits, so repeatedly running it to force retries wastes attempts and defeats recovery. Use it after evidence the named prerequisite has recovered. Authentication requires the owner's supported login flow, not token copying or a new subscription purchase.

If the bridge reported a timeout, reconcile its operation ID and the AIWorks campaign before another write. A missing response is not proof that the command failed. A pre-acceptance bridge rejection means no local command was accepted; record that separately from AIWorks readiness.

## My message did not start work

That is expected: `message` is a planning request. Read `messages` to see configured/blocked state and the received/read/answered receipt. An absent or disabled coordinator stores the message without reading it. Its answer is published to configured `reportTo`; do not assume it is in the project issue you happened to mention.

To implement, follow [the approved declaration and start path](FIRST_PROJECT.md). Do not ask the read-only coordinator to grant itself write tools.

## The result says finished, but the product is not live

Publication completes a declared deliverable. It does not prove a merge, a release or the original user journey. Inspect the exact verified revision and actual CI. CI repair and integration repair only run when the relevant installed switches are enabled. Local Git/folder work must not show fictitious PRs, and optional Auto Release is not implicitly enabled by a campaign start.

## Pause, stop and recovery

A deliberate `<data>/STOP` keeps the controller/keeper stopped. Inspect why it exists before removing it. Confirm campaign controls and any owned operation first; stopping the controller is not immediate proof a worker stopped. Cancel and then inspect resulting status when cancellation is intended.

Do not delete SQLite/WAL files, clear counters, remove worktrees, force-push a verified branch, or kill all AI processes as a recovery shortcut. Use the [supervisor runbook](../SUPERVISOR.md), particularly ownership/restart handling and the [upgrade procedure](../SUPERVISOR.md#upgrade).

## Report a useful bug

Include OS, Node/Git/worker versions, AIWorks source and controller SHAs, the specific action, actual/expected result, sanitized readiness/error code, and a minimal disposable reproduction. Indicate whether the evidence is a synthetic demo, source inspection, CI or an actual local run. Redact user paths and identifiers where unnecessary. Never upload supervisor.db, raw worker transcripts, .env files, tokens, screenshots of customer data or a complete config without reviewing it.

Use [private security reporting](../../SECURITY.md) for suspected credential exposure, unauthorized execution or cross-project/device access. Ordinary bugs use the repository issue template.
