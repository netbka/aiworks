# Run your first project task

This guide uses the existing CLI. It does not require the dashboard's unfinished Add project or approval screens to be complete. Prerequisite: [a real local installation](INSTALLATION.md#install-for-real-project-work) with a working provider, approved governance and an actual GitHub-backed project.

## Choose a small outcome

A useful first task is a read-only report: identify missing installation information in your project's README, quote the relevant file locations and propose corrections without changing files. A successful result is a separately verified report posted to the designated issue, not an application release.

The inert [report declaration example](examples/campaign-report.example.json) demonstrates the format. It deliberately lives outside `campaigns/`. It refers to `example/project`, uses a fictional approval reference, and **must not be registered unchanged**. Schema-valid does not mean authorized or operationally ready.

For real work, an owner or authorized setup assistant prepares the declaration from the outcome. Replace campaign/tenant/project/repository identity, target branch, tracking/task issue numbers, authorization author/date/reference/text, model and references. Each referenced file must exist in the target checkout; `README.md` is relative to the target project, not AIWorks. The target must match its approved governance record. Never invent an approval link.

The sample is report-only and uses `researchOnly: true`, so workers reason from the bounded evidence collected by the controller rather than running arbitrary project commands. A report whose acceptance needs live checks requires a separately appropriate, authorized executor configuration; do not treat this example as a universal verifier.

## Prepare the declaration under the existing rules

Use an isolated development branch, not the running runtime. Put the approved declaration at `campaigns/<campaignId>.json` in the AIWorks source repository, validate it, and submit it through the existing review/merge workflow. Use a branch name such as `declare/<campaignId>`, never `campaign/<campaignId>`: that name would conflict with the supervisor's task branches.

A standalone syntax/shape check can be run from a development checkout with dependencies installed:

```powershell
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { validateDeclaration } from './src/supervisor/campaign.mjs'; validateDeclaration(JSON.parse(readFileSync(process.argv[1], 'utf8'))); console.log('Declaration shape valid; not authorization or registration');" docs/guides/examples/campaign-report.example.json
```

The focused documentation tests validate the example too. For a real declaration change, run the required repository checks. Existing owner approval can be recorded faithfully without asking again for each assigned child; an example file or public issue comment does not create that approval.

After review and merge, the runtime must contain the exact committed declaration. A running older runtime may not contain a newly merged file. Use [the upgrade procedure](../SUPERVISOR.md#upgrade), coordinated with its current operator; do not copy a modified JSON file into the live runtime, switch its HEAD under active workers, or disable AW-005.

**Current public-installation gap:** today this declaration path is coupled to the installation's governed AIWorks source and approved project registry. Do not submit your private task descriptions to a public upstream project. Public self-service intake must remove that coupling before it is advertised as supported. See [the release checklist](../publication/RELEASE_CHECKLIST.md).

## Start an approved campaign

Confirm the controller is already running as described in the installation guide. In another PowerShell terminal:

```powershell
$Runtime = 'C:/Work/aiworks/.local/runtime'
$Data = 'C:/Work/aiworks/.local/supervisor'
$Campaign = 'my-approved-work'
Set-Location $Runtime

# Read first when this may be an existing assignment.
node src/supervisor/cli.mjs status $Campaign --data $Data

# Use this runtime's own reviewed, committed declaration.
node src/supervisor/cli.mjs start "campaigns/$Campaign.json" --data $Data
node src/supervisor/cli.mjs status $Campaign --data $Data
```

Replace the campaign name with the real approved one. On the first run, `CAMPAIGN_NOT_FOUND` can be expected before registration, but first confirm the data directory. `STORE_NOT_FOUND` is not permission to create a replacement installation. An existing campaign with identical declaration is resumed/idempotently registered; do not generate a new ID to work around an error or duplicate-work refusal.

`start` performs registration/amendment/resume; it is not the persistent service. The service is `serve` or the installed keeper. A successful start response alone does not prove work has begun.

## Confirm what is actually happening

Read `status` and the local dashboard. Check the selected store, controller revision, campaign identity, task state, operation evidence, blockers and next wakeup.

| Evidence | What it means |
| --- | --- |
| `BOOTSTRAP_REQUIRED` | No controller lease has been acquired for this campaign. Registration is not active execution. |
| `CONTROLLER_OFFLINE` | A previously recorded controller lease expired. Investigate process/operation state before recovery. |
| `ACTIVE` | A live controller lease was observed. It does not by itself mean a model worker is running. |
| Implementing or verifying task plus a matching operation | The recorded stage is underway; inspect freshness and actual worker evidence. |
| Provider wait | Work is waiting for an eligible provider, not automatically for an owner decision. |
| `COMPLETE` / all declared results published | Campaign deliverables reached the publication boundary, not necessarily merge, deployment or original business-outcome acceptance. |

A controller heartbeat is not task progress. Missing/unknown evidence is not success. For a report, open the actual issue comment and its verification evidence. For code, inspect the verified SHA, PR and CI on that SHA. The same result should not be posted twice after a retry. Do not declare the original request complete while its acceptance requirements remain uncovered.

## A code-changing follow-up

After the report is accepted, choose one specific correction or small bug fix. An owner-authorized code declaration uses `deliverable: "commit"`, a compatible non-research executor, narrow change scope and reproducible tests. Its output is a separately checked commit and a PR, not direct edits to your working checkout. The read-only report example must not be silently repurposed in place after registration: new scope follows the existing declaration/approval rules.

The supervisor does not merge/deploy in this quickstart. Keep integration, release and live acceptance separate. CI/integration repair exists behind its configured switches; do not assume either is enabled merely because its code is present.

## Pause, resume and recheck

From the runtime checkout, using the same `$Campaign` and `$Data`:

```powershell
node src/supervisor/cli.mjs pause $Campaign "Pausing this assignment" --data $Data
node src/supervisor/cli.mjs status $Campaign --data $Data

# Resume with the identical committed declaration, not a new campaign ID.
node src/supervisor/cli.mjs start "campaigns/$Campaign.json" --data $Data

# Only after the named underlying problem has actually been resolved:
node src/supervisor/cli.mjs recheck $Campaign --task T1 "Verified the prerequisite is restored" --data $Data

# Request cancellation; inspect status until its actual state is known.
node src/supervisor/cli.mjs cancel $Campaign "This assignment is no longer needed" --data $Data
node src/supervisor/cli.mjs status $Campaign --data $Data
```

These are alternative operations, not a script to execute from top to bottom. Pause/cancel/stop does not itself prove that every previously dispatched process has terminated. Do not force-kill unrelated processes or delete worktrees.

To inspect reported usage without new model calls:

```powershell
node src/supervisor/cli.mjs baseline --json --data C:/Work/aiworks/.local/supervisor
```

Unreported dollars/tokens remain unknown. A budget limits authorized work; it is not a promise about exact provider billing.
