# Owner journey acceptance (synthetic, disposable runtime)

**Privacy boundary:** synthetic only. Two fictional projects, a synthetic AI worker and the synthetic governance fixture; no installation, account, recipient or private project. Screenshots and `journey.json` stay in the disposable folder, outside this repository; only the reviewed selection of the [static showcase](../../site/README.md) is committed.

**What this is.** The local owner journey of [issue #39](https://github.com/netbka/aiworks/issues/39), run on the production entry points of the source revision under test, with findings repaired in the same change. It is a scripted behaviour and layout check by an AI implementer, **not a human usability study**, and it says nothing about any installed version: merged source is not deployed.

## How to run it

```
node scripts/supervisor/owner-journey.mjs journey <new-folder>
```

Windows with Chrome installed. `<new-folder>` must be new or empty and lie outside every Git repository and the home folder, because project preflight refuses owner folders there. The script:

- copies this checkout's `src`, `scripts/lib`, `registry`, `schemas` and the test fixtures into `<new-folder>/runtime` as one commit that its own `origin/main` contains, so merged-code admission (AW-005) holds;
- starts the real `src/supervisor/cli.mjs serve` and `src/dashboard/main.mjs` from that copy, each hidden and through a launcher that exits at once, as a scheduled task would start them. The dashboard keeps its production Windows caller lookup;
- starts headless Chrome the same way, as a browser the owner opens: no AIWorks job, and no live parent in this session;
- drives Chrome over the DevTools protocol through 32 steps, writing each outcome to `<new-folder>/evidence/journey.json` with the source commit and whether it had uncommitted changes. Screenshots go beside it, with the computer's name replaced by a fictional one. The [static showcase](../../site/README.md) is built from a reviewed selection of them;
- stops every process it started.

The AI worker is `tests/supervisor/fixtures/fake-claude.mjs`. It makes no model or network call and plays planner (`scenario.intake`), builder (`commit-page`, `owner`, and `probe-commit-page`, which tries the owner's Apply from inside its job) and independent checker. Everything else is the product's own code: intake, admission, Windows job containment, verification of the exact head, local candidates, preview capture, Apply and Undo apply, the alert outbox with the synthetic rehearsal transport, and every dashboard route.

Without the exiting launcher, a process this session started would have this session's processes above it. The caller check cannot open some of those and fails closed with `APPROVAL_UNCHECKED`. That is the designed behaviour, so the script models the owner's and the scheduled task's ancestry rather than weakening the check.

## What the journey checks

| Step | Observed |
| --- | --- |
| Home, empty | "No projects yet" with Add project |
| Idea first, connect a plain folder, confirm its rules | Protected action accepted from the browser through the production Windows lookup |
| Ask for a plan, Edit plan, save version 2, approve | Draft from the planner run; an edit draft survives navigation; "Priority: Normal → High" listed as a change; Approve and start admits exactly that version |
| Isolated implementation, independent check of the exact head | A local candidate at the verified commit; the owner's folder untouched |
| Try this version, Capture screenshots | Sealed `allow-scripts` frame; desktop and phone captures under job containment |
| Apply with a conflicting owner edit | Refused, file named, nothing written |
| Apply, unrelated owner edit present | Applied; the unrelated edit kept |
| Undo apply over an edited applied file, then without | Refused with the file named; then the folder restored byte for byte, the unrelated edit kept |
| A step stops for the owner | Listed in Needs you under its project and on Home with the decision card; answered on Overview with a draft kept across navigation; the answer reaches the next builder run; the step is checked again |
| Settings › AI workers while the local goal waits | Counts every unfinished goal that allows the worker, the local one included |
| Alert | Recorded by the rehearsal transport, nothing sent, nothing reported delivered; it names the project as the owner named it and the dashboard's own actions, with no `lp-` id, task issue or CLI command |
| Local Git project; its builder tries Apply from inside its job | Refused with `APPLY_FROM_AIWORKS` (or `APPLY_UNCHECKED` while the runner is still identifying itself); the owner's folder untouched |
| Local Git Apply with a dirty tree; Apply; Undo after an owner commit; Undo | Refused, branch unmoved; fast-forward with a clean tree; refused, owner commit kept; branch back at its base |
| Drafts and focus | Plan work drafts stay with their project; route changes move focus to the screen title |
| Knowledge, project budget, alert rules | Each saved through the caller check; the budget counts planning and work |
| Usage, Releases | Usage counts local work's runs; Releases says a local result is applied from Review, never released |
| Cost of local work | Each project's goals only, with each step's runs, models and cost; a project's total is its own goals' runs; Usage equals the goals' sum, so nothing is counted twice; Overview shows the breakdown (desktop and 320 px seen) |
| Dashboard restart under an open page | The page reconnects and the next owner action works without a reload |
| 320 px window and 390 px phone | No screen scrolls sideways (13 routes each) |
| Every goal finished | No alert waits or is being sent; none was delivered |

Checked by hand on the same runtime as well: keyboard-only answering, using Tab to Send answer with a visible focus ring; the offline state, which turns controls off and says *Disconnected · retrying*; Request changes on a local result, which ran a repair round that was checked again; the sample project; desktop and narrow screenshots of every tab.

## Findings repaired in this change

- **Local decisions were invisible.** A local step stopped for the owner was left out of the supervisor snapshot. Needs you said nothing waited, Overview said "All steps are finished", and the decision could not be answered. Local steps now carry the same decision record (`src/dashboard/work.mjs`). Needs you and Home list it under its project (`src/dashboard/owner.mjs`, `src/dashboard/projects.mjs`), and Overview answers it with the shared decision card through the existing bound route. A stop without options shows what the worker asked, credential-filtered.
- **A restarted dashboard refused the open page's next command** until a manual reload: the CSRF token had changed. The page now takes a new session when it reconnects.
- **Untrue statements:**
  - a stale "waiting for AIWorks to pick it up" after the work had finished;
  - "not added up" beside a counted budget;
  - "No run reported a dollar cost" in Usage, which ignored local work;
  - "No checked result yet" on a local project's Releases;
  - "published … merge gate" in a local project's settings;
  - "runs and checks under Details", which local work does not show;
  - "the step issue says what it needs" where there is no issue;
  - "Working on: ….." with a doubled period.
- **Layout:** lists placed straight in a panel (Plan, Results, a local project's Review) touched the panel edge at every width. They now keep the panel body's inset (shared CSS, recorded in DESIGN.md).

## Owner UI v2 screens and plan outcomes

| Screen ([OWNER_UI_V2 §6](OWNER_UI_V2.md#6-screens)) | In this journey |
| --- | --- |
| 1 First run | Idea first, planning cost "unavailable" before any plan, sample project created and connected |
| 2 Home | Since-last-visit line, first decision answered in place, one sentence per project |
| 3 Overview | Current goal, budget, decision first, results waiting; the Built / Checked / Available strip is for GitHub goals only |
| 4 Plan | Now / Next / Later, version history, Edit plan |
| 5 Decision | Free-text decision answered, snooze and "did not need me" present; structured options are covered by `tests/dashboard/decisions.test.mjs`, not by this journey |
| 6 Review | Criteria with "Not checked" where the checker reported none, preview, captures, Apply as acceptance, Request changes |
| 7 Releases | Publish not available, with why; nothing is released |
| 8 Knowledge | Material and AI suggestions, confirm, owner fact, requirements, answers, history |
| 9 Project settings | How work runs, never-list, protected areas, budget with unreported-run price |
| 10 Settings | Usage by source, alerts with rehearsal, connections |
| 11 States | Offline, refused Apply and Undo, decision stop and a failed planner run seen; not every state of the list was produced |
| 12–15 Phone, Try this version | Phone layouts and a decision answered at 390 px; preview and captures |

Against the [PROJECT_WORKSPACE_PLAN acceptance definition](../PROJECT_WORKSPACE_PLAN.md#1-product-stated-from-the-owners-job): two local projects were connected, one a plain folder without Git and one a local Git repository. Work was planned, approved, checked and inspected for both, and no pull request was shown for either. GitHub-backed projects were not part of this journey; their paths keep their own tests.

## Still open

The duplicate "Worker accounts" link in Settings, listed here at first, is removed since. So are four later findings: local work's per-step models and cost, local work under Settings › AI workers, a finished goal's alert left *Waiting*, and a local project's alert naming its `lp-` id, a task issue and a CLI command; the journey now checks each. [STATUS.md](../STATUS.md#still-open) keeps the current open list.

| What | Cause | Next action |
| --- | --- | --- |
| A human study of the novice flow | None has taken place | Run the plan's blind UX test with a person; this record is not one |
| The local trusted-main route (Settings › Connections) | Needs AIWorks's own repository with `selfHosting.trustedMain` set to local, which is not in this synthetic runtime | A self-hosting rehearsal |
| Real notification delivery, release destinations, remote access | Owner-reserved configuration and authority | Stay off until the owner configures them |
