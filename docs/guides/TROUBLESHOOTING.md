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
| Target is not a registered project | Configuring a repository path is not governance registration. Use the governance provider's approved registration workflow. |
| `RUNTIME_NOT_MERGED` / `runtime-not-merged` | The runtime must be an ancestor of the trusted main, and which main that is depends on the installation. With origin trust, compare it to the last fetched `origin/main`. With `selfHosting.trustedMain: "local"`, compare it to the trusted tip printed on the first line of `node <runtime>/src/supervisor/cli.mjs trusted-main --data <data>`, never to raw local `main` or `origin/main`: a commit on local `main` that the main ledger does not record is not trusted. An old merged revision is allowed; an unmerged branch is not. The check is read-only and never fetches. If local `main` holds commits AIWorks did not put there, the owner reviews them in Settings › Connections and chooses **Trust local main**; commits that change `src/supervisor/` are refused there and still need an independent review of their exact head. Do not bypass provenance, hand-edit refs or the ledger, or update an active runtime in place. |
| `STORE_NOT_FOUND` | Confirm the installed task's data path. Status is read-only and does not create a new store. Start the legitimate installation's controller only after identifying it. |
| `CAMPAIGN_NOT_FOUND` | Check store and campaign identity. On a first assignment registration may be pending; on an existing assignment a wrong data path is a likely cause. |
| `DATA_DIR_MISMATCH` | Make explicit --data and AIWORKS_DATA agree, or remove the stale shell variable. Do not silently search for another database. |
| `WORK_ALREADY_ASSIGNED` | Inspect the reported owning campaign/task. Reuse or sequence that work; a new ID is not a solution. |
| Provider executable cannot start | Check its actual native executable path, Windows account, installed version and adapter/role eligibility. An interactive .cmd wrapper is not proof of headless support. |
| Port 4318 or 4319 is busy | Identify the process/installation already using it. Do not kill arbitrary node processes. Stop only your own disposable demo or use the documented operating procedure. |

## The agent appears to be waiting

`ACTIVE` describes a controller lease, not a currently working model. Inspect task/operation state, progress time, provider wait and next wakeup. A declared fallback may be unusable for this host or role. Do not remove its sandbox protections.

Most waits are routine and need no owner action. AIWorks keeps its own timers and resumes by itself:

| Wait | What happens |
| --- | --- |
| Provider usage limit | A subscription limit is held for the provider account, for every campaign on this PC that uses it, until its recorded reset (30 minutes when none was reported). It sends no owner notification, and the work resumes by itself. A declared alternative provider takes the step only if it is already authorized for that role. |
| Failed attempt or timeout | Bounded retries with backoff. Four fresh sessions that end without evidence stop the task with a decision for the owner. |
| Publication rate limit | The result publishes by itself at the reset time. |
| Merge waits | A merge waits while local `main` holds commits AIWorks did not put there, or while the checkout that has `main` checked out has unsaved changes. Saving or committing that work in the checkout lets the wait end; AIWorks never merges over it. |

A known provider limit should be allowed to reset. `recheck` can clear waits, so repeatedly running it to force retries wastes attempts and defeats recovery. Use it after evidence the named prerequisite has recovered. Only these need the owner: a login that must be restored through the supported login flow (not token copying or a new subscription purchase), a paid upgrade, a budget the owner set, a worker's `blocked-owner-reserved` decision, a boundary violation, or an access or destination only the owner can grant. A decision shown in the dashboard is answered there. Anything else is investigated by AIWorks, not by the owner.

If the bridge reported a timeout, reconcile its operation ID and the AIWorks campaign before another write. A missing response is not proof that the command failed. A pre-acceptance bridge rejection means no local command was accepted; record that separately from AIWorks readiness.

## My message did not start work

That is expected: `message` is a planning request. Read `messages` to see configured/blocked state and the received/read/answered receipt. An absent or disabled coordinator stores the message without reading it. Its answer is published to configured `reportTo`; do not assume it is in the project issue you happened to mention.

To implement, follow [the approved declaration and start path](FIRST_PROJECT.md). Do not ask the read-only coordinator to grant itself write tools.

## The result says finished, but the product is not live

Source acceptance, a merge, runtime installation and a release are separate facts. Publication completes a declared deliverable, and independent verification accepts one exact head. Neither proves that the head is merged, that the running runtime contains it, or that the original user journey works. A merged change reaches the running system only through the [upgrade procedure](../SUPERVISOR.md#upgrade), which deploys the exact trusted-main revision: `git rev-parse origin/main` with origin trust, or the first line of `trusted-main` with local trust. Compare the runtime revision from the first command on this page with that commit before saying the change is live.

Under the No Actions policy this project and the repositories it manages are built and tested on this computer. Do not look for, enable, dispatch or rerun hosted CI. Check the verified result locally: the recorded verification of the exact head, the local test and check commands the repository documents, and `status`, which reads only the journal. A published head's `ci` of `unknown` or `none` is expected there. Integration repair and CI repair only run when the relevant installed switches are enabled. Local Git/folder work must not show fictitious PRs, and optional Auto Release is not implicitly enabled by a campaign start.

## Pause, stop and recovery

A deliberate `<data>/STOP` keeps the controller/keeper stopped. Inspect why it exists before removing it. Confirm campaign controls and any owned operation first; stopping the controller is not immediate proof a worker stopped. Cancel and then inspect resulting status when cancellation is intended.

Do not delete SQLite/WAL files, clear counters, remove worktrees, force-push a verified branch, or kill all AI processes as a recovery shortcut. Use the [supervisor runbook](../SUPERVISOR.md), particularly ownership/restart handling and the [upgrade procedure](../SUPERVISOR.md#upgrade).

## Report a useful bug

Include OS, Node/Git/worker versions, AIWorks source and controller SHAs, the specific action, actual/expected result, sanitized readiness/error code, and a minimal disposable reproduction. Indicate whether the evidence is a synthetic demo, source inspection, CI or an actual local run. Redact user paths and identifiers where unnecessary. Never upload supervisor.db, raw worker transcripts, .env files, tokens, screenshots of customer data or a complete config without reviewing it.

Use [private security reporting](../../SECURITY.md) for suspected credential exposure, unauthorized execution or cross-project/device access. Ordinary bugs use the repository issue template.
