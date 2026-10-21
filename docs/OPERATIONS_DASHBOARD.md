# Operations dashboard

Coordinator plans and replies stay in the local dashboard, under their message receipt and the requesting project's Start work receipt. "Read the plan" shows the checked final answer as text. Planning creates no GitHub issue, PR or comment. Each plan request retains its selected repository and runs separately; only registered campaign work publishes to its declared target repository ([AW-004](DECISIONS.md#aw-004---the-coordinator-is-read-only)).

Long displayed bodies are checked outside the dashboard request loop (`src/dashboard/display-text.mjs`). Coordinator messages and replies, instructions, plan goals/summaries/details, local reports and work-item bodies/comments over 256 characters show a checking notice until the existing credential classifier finishes. A timeout or worker failure shows unavailable text, not a claim that the body contains a secret; the original work record is unchanged. Plan approval and editing remain unavailable while its text is being checked. Owner-input validation keeps its synchronous classification contract.

Each dashboard owns one checking thread, with a five-second deadline, bounded JavaScript heap, at most 20 queued bodies of 200,000 characters each and 512 exact-content receipts. Only a completed check can reveal the corresponding text. Failed checks stay cached so polling cannot restart the same expensive work. Shutdown terminates the thread. These bounds protect the dashboard loop; they do not claim that every nested input can be fully classified within the deadline.

Owner request, 2026-10-09: see the entire roadmap, completed and ongoing work, and send basic commands to agents. First delivered in governance provider (#60); the owner view is tracked in AIWorks design work. This is the local operations surface for the AIWorks delivery supervisor. It is not governance provider's project portal.

## Run

Requires Node 22.5 or newer and `git`. The dashboard needs no `gh` sign-in: it makes no GitHub API call (AIWorks design work). From this checkout:

```sh
npm install
npm run dashboard -- --data C:/example/aiworks/.local/supervisor --governance C:/example/aiworks/.local/governance
```

Open **http://127.0.0.1:4318**. Optional arguments are `--port` and `--governance`. `--cache` is still accepted so existing launch commands keep working, but the old roadmap cache is unused: `.local/dashboard-cache/roadmap-cache.json` is no longer read and can be deleted. `--governance` names the governance checkout and defaults to `governanceRoot` in the data directory's `config.json` ([SUPERVISOR.md §6](SUPERVISOR.md#governance-checkout)). Without one, the roadmap panel says "governance checkout not configured". Launch background instances with a hidden process, as required by the Windows command-window rule. On workstation it runs as the per-user task `AIWorks Dashboard`. Starting the dashboard does not start, pause, resume, upgrade or restart the supervisor.

## Ownership and updates

The dashboard (`src/dashboard`) and delivery supervisor (`src/supervisor`) belong to the AIWorks repository. GitHub branches and PRs hold unmerged work; merge status remains in GitHub rather than this runbook.

The active local service uses a detached checkout of a merged, independently reviewed commit on main at `C:/example/aiworks/.local/runtime`. Updating the main development checkout does not change that running version; upgrade the pin using the [supervisor procedure](SUPERVISOR.md#upgrade). Local state lives at `.local/supervisor`, generated target worktrees at `.local/worktrees/<repo>` and the governance checkout at `.local/governance`, relative to the AIWorks root. `.local/` is ignored by Git and is not part of a source update. Target checkouts remain at `C:/example/<project>`. See the [supervisor layout and relocation procedure](SUPERVISOR.md#6-installation-and-maintenance).

## What the owner sees

- Overview: **Needs you** first, then a card for each campaign that has something listed for the owner or is still active, then live agents and roadmap progress. Finished and cancelled campaigns with nothing listed come after that, as one line each.
  - **Needs you** is built from supervisor fields and local git, never from worker output or the GitHub API. It lists:
    - published steps whose merge is not seen yet, for the owner's review and merge, with the steps that build on them and any step that took many tries. When the owner delegated merging, verified ones are not listed until nothing has merged them for `merges.stallHours` ([Merging delegated by the owner](#merging-delegated-by-the-owner));
    - owner decisions and stopped steps;
    - a supervisor that is not running. That is said only from the computer-wide state the supervisor reports (`supervisorLiveness`: no lease live for a minute), once, under AIWorks itself. When it holds up work in several projects, AIWorks itself is listed before the project groups (OWNER_WORKSPACE §4.2);
    - one piece of work the running supervisor has not checked on, or not picked up, past the 5-minute grace. It is listed under its own project with the time its lease ended, never as a stopped supervisor (aiworks#11 review 4 F2);
    - a coordinator that cannot read messages;
    - a finished step with no recorded result link. The item says *Check on GitHub* and links the step issue.

    A link to the coordinator's latest answer sits under the list. The **Needs you** metric counts these items. A published step whose merge check is still running or due is shown as `?`, never as nothing, and the Needs you count in the header reads partial, for example *7 + checking*, until the check ends. A project's state on Projects says the same (OWNER_WORKSPACE §4.1, aiworks#11 review 4 F3). With nothing else listed, the heading then says *Checking for merges before listing what needs you*.
  - **Each step item leads with its subject.** There is one item per step. The item starts with what to do (*Review and merge*, *Decision needed*, *Check on GitHub*), then what the step delivers (its declared `outcome`, else its title) and an *Open PR* or *Open step issue* link.
    - The evidence is one compact line, *Checker accepted aaaaaaa · CI and conflicts on the PR*. Opening it shows the full sentence. The dashboard does not read CI checks or conflicts: the pull request shows them.
    - The repository and campaign follow in small text.
  - **A pause is not an owner item by itself.** The store does not record who paused a campaign, so the dashboard does not guess from the reason text. The campaign card shows the pause in a neutral state: the chip reads, for example, *AIWorks running · work paused*, and the banner gives the time and the reason as given. A blocker or a stopped step in a paused campaign is still listed.
    - A paused campaign still needs a running supervisor, because the controller renews its lease too. A stopped or absent supervisor is listed once the 5-minute grace period has passed:
      - *The supervisor on &lt;host&gt; stopped while &lt;campaign&gt; was paused*, with the restart action, for example when an upgrade paused campaigns and the restart failed;
      - *The supervisor on &lt;host&gt; has not started &lt;campaign&gt; yet (it is paused)*.

      The card's chip then uses the warning tone, and the banner names the stopped supervisor.
  - **Calm text covers only blocking items.** With no item and no merge check pending, the heading says *No work is blocked on you right now*, never "nothing needs you": Needs you checks work only, and a project setup problem is said on Add project and Projects (OWNER_WORKSPACE §4.2). Reports to read and finished campaigns whose merged work is ready are not blocking. When they exist, a line names them, for example *Also: 2 reports for you to read · merged work in sampleapp is ready; release follows its standing deploy authorization*. The metric says the same in short form.
    - The dashboard has no read or release state. The line counts reports that were posted and merged work that is ready, not what is still unread or unreleased.
  - **Release follows the project's registry entry.** The dashboard does not assume the owner releases.
    - Where a project records a standing deploy authorization (`governance.releaseAuthorization`, GOVERNANCE_INHERITANCE §9, governance-029), release sentences say *release follows sampleapp's standing deploy authorization*.
    - Otherwise they say *release follows &lt;repository&gt;'s release policy*.
    - The registry is read once at dashboard start from the governance checkout.
  - **Finished campaigns** with nothing listed for the owner collapse into *Finished campaigns (N)*, most recent first. Each has one line saying where its results stand and a *See all steps* disclosure. A finished or cancelled campaign card shows no controls. The Agents page uses the same order.
  - **Old or failing merge checks in Needs you.** A review item says *Merge check from 12:31; the last fetch failed, retrying within 5 minutes* when the last fetch of the base branch failed. The result of the last successful fetch is kept and its time is shown.
    - A merge check is current for 15 minutes after a successful fetch. Without a recorded merge receipt, older data never shows a step as merged. While a new check is due, the step counts as being checked; once a fetch has failed, it is listed for review with the time of the last good check.
    - A supervisor merge receipt bound to the task, verified commit and published PR remains evidence of that historical merge. Needs you, Projects and Results read new receipts on refresh, including a reconciled canonical PR link. Cancelled work without merge evidence still needs review; a merge receipt does not prove deployment.
  - **Campaign heading:** declared wording first.
    - It is the campaign's `purpose` or, for a campaign of one step, that step's `outcome`, else its title.
    - Otherwise it is the campaign id. Issue titles are not read from GitHub.
    - Campaigns that share a heading get a distinguishing name in parentheses, built from the words of their ids that differ. Issue numbers are dropped (*Open runtime PRs*, *Design contracts*) unless names would otherwise be the same.
  - **Each step:** the declared plain-language `outcome` first (the slice title is secondary) and where it stands for the owner: *Merged*, *Published, merge not seen yet*, *Report posted* or *Result not known*. A step that took 5 or more tries, or was rejected by the verifier, carries a "Took N tries" note. This is information only and never a limit.
    - The line under *Published, merge not seen yet* says why when the merge cannot be seen yet: the check is still running, the last fetch failed, this computer has no checkout of the repository configured, or no verified commit is recorded. A finished step with a missing or unrecognised result link is *Result not known*, never settled.
  - **Runs, cost and the provider chain** are folded into a details row.
  - **Since you last looked** comes first. It covers steps merged, steps delivered, steps newly waiting for the owner, and agent runs that failed or were rejected by the independent checker.
    - A merge counts by the time of its merge commit in local git. A fast-forward has no merge commit, so it is shown as merged but not counted here.
    - The supervisor's own step errors and liveness problems are a separate line for whoever maintains AIWorks. They are never counted as agent runs; a failing supervisor step is recorded on every check.
    - The window starts at the viewer's last visit, kept in that browser's `localStorage` (a per-viewer convenience).
    - A first visit, or a browser that blocks storage, shows the last 24 hours.
    - The server counts from the journal through `/api/state?since=`, bounded to 30 days.
  - **Needs you, per pull request.** Each pull request item says:
    - which commit the independent checker accepted, and that CI checks and conflicts are on the pull request. The dashboard never says *Ready to merge*;
    - why the merge cannot be seen on this computer, when there is no checkout of the repository or no verified commit;
    - what to check first (many tries or rejections);
    - what merging unlocks or, when nothing else waits on it, the project's release rule. Only steps that have not started yet are named, as *cannot start until you merge it* or *Merging lets X build on it*. A step starts from the base branch as it is at its first run and keeps that base, so a dependent that has already started is named as *already started without it, so merging now does not change that step*.
  - **Supervisor not checking in.** If an agent is still working, the item says so and names the host, the last check-in time and the concrete restart action. For the first 5 minutes after the controller lease lapses, the campaign shows *Supervisor checking in late* and no restart advice, because a restart or an upgrade is usually in progress.
    - A campaign that no supervisor has picked up yet gets the same 5 minutes from its registration. During that time it shows *Waiting for AIWorks* and no restart advice. After that, Needs you says *The supervisor on &lt;host&gt; has not started &lt;campaign&gt; yet* with the restart action.
  - **Reports.** A posted report says *For you to read and decide on*. It is for the owner to read, not "nothing to do".
  - **Finished campaigns.** The banner says *nothing waits for you* only when every step is merged or a report. Otherwise it says plainly what is open:
    - merges still being checked, or a missing result link;
    - steps waiting for review (merge not seen yet);
    - reports to read. A campaign of reports only shows the supervisor's own next action (review the recommendations before assigning implementation), or *N reports posted for you to read*;
    - merged work that is ready, with the project's release rule.
  - **Agent verdicts.** Each agent shows *Working normally*, *Possibly stuck (no progress for N min)*, *Starting* or *Not started*, from its own session record. The rule is explained once on the page.
  - **Cost so far** totals the reported cost across campaigns with a cost per delivered step. A run without a reported cost, including one still in progress, is *not reported*, never $0.00.
  - **At 520px or narrower:**
    - step tables become stacked rows;
    - the progress line shortens;
    - navigation becomes a labeled bottom bar.
  - **Dates** are English (`10 Oct 12:23`) whatever the computer's locale.
  - **Navigation.** Choosing a view opens it at its top. Back and Forward return to where that view was left (UX-001 preserve-context).
  - **Large screens.** From 1900px wide the whole page is scaled by 1.12. From 2300px it is scaled by 1.25 and the column is wider, so text is not 10–12px on a 2560px screen.
  - **Background.** The page is light only, and its background is explicit, so a dark system preference never shows through.
  - **Supervisor faults** say they are not an owner action and link the supervisor issue (AIWorks design work). The "since you last looked" line also links to Activity, which shows when they happened.
  - **Owner words only** (OWNER_WORKSPACE §2.1, aiworks#11 review 4 F4 and F17). Outside Details and Settings › Diagnostics, the page never says *supervisor*, *coordinator*, *agent* or the governance platform's name. It says *AIWorks*, *AI worker* and *your project rules*. No test pins these words (AGENTS.md test rule); the owner review checks them.
  - **Message and Start work receipts** read like OWNER_WORKSPACE §5.4: *Sent · AIWorks received your request at 12:31*, then *Read*, then *Answered*. A waiting request gets a pickup time (*usually starts on a request within a minute*) only while the request reader holds a live lease. Otherwise the receipt says AIWorks reads it when it next runs, or that AIWorks has stopped (aiworks#11 review 4 F12).
  - **A last result of *invalid result*** on the Step screen is explained in place: what kind of failure it is and, when the step has stopped, what *Fix the cause* involves. The words come from the result's class and role only, never from the worker's text (aiworks#11 review 4 F13).
- Roadmap: registered project campaign plans and their results, followed by the governance provider roadmap from the governance checkout: its product phases, post-MVP increments and governance rollout packages, with their roles and dependencies. These are definitions only: their progress is tracked on GitHub and not read here. Search and the track filter apply to the platform packages. A campaign plan is its authorized scope, not the target repository's entire backlog.
- Issues & PRs: every campaign step with its issue, its pull request or report and where it stands, from the supervisor's own records (issue numbers and titles come from the declarations). Search and the status filter apply. Issues and pull requests that no campaign owns are not shown.
- Agents & tasks: running implementer/verifier operations; for active campaigns only, configured provider priority, waiting reasons and retry times, worker slot limit, role restrictions, queue/dependencies, outcomes and result links. A heartbeat proves the runner is alive, not that the task is progressing. Last output time is file metadata only; providers emitting only a terminal receipt may have no output until completion.
- Activity: worker starts/outcomes, provider switches with their reason, verified publications and owner commands. Duplicate dashboard processing and lease-renewal bookkeeping are omitted.

The sidebar and footer name the computer and the dashboard revision. Until the first answer arrives, the sidebar shows a neutral "…" rather than a guess. Each computer runs its own supervisor, campaigns and dashboard, so a screenshot shows which one it came from. A provider that cannot run on this computer at all (Cursor's native sandbox on Windows) shows as *Not available on this machine*, not as eligible for retry.

## Where the data comes from

The dashboard makes no GitHub API call: no `gh`, GraphQL or REST (AIWorks design work).

- **Campaigns, steps, published pull request and report links, verified commits:** the supervisor store, read-only.
- **Issue numbers and step titles:** the stored campaign declarations.
- **Platform roadmap and release rules:** the governance checkout, read once at start.
- **Merged or not:** local git. A published step is merged when its verified commit is reachable from `origin/<baseBranch>` in the repository's checkout configured in the supervisor's `config.json` (`git merge-base --is-ancestor`).
  - The dashboard refreshes that branch with `git fetch --no-tags origin <baseBranch>`, over the git protocol, at most once per repository every 5 minutes, one repository at a time. A failed fetch waits the same 5 minutes.
  - Fetches happen only while a dashboard page is open: each state request starts a check, and the answer never waits for it.
  - Otherwise the step reads *Published, merge not seen yet*, never merged. That includes a repository with no configured checkout, a step with no recorded verified commit, and a squash or rebase merge, which rewrites the commit so it is never reachable.
  - A failed fetch keeps the last result and shows its time. A check older than 15 minutes never shows a step as merged.
- **AIWorks's own repository with local main trusted** (`selfHosting.trustedMain` `"local"`, UI19): never fetched. Its merge check reads the local `<baseBranch>` (`refs/heads/main`) at every check, and a verified local review (`aiworks-work:<n>`) counts as published. Every other repository keeps the fetch above.
- **Who merges:** the `merges` setting in the supervisor's `config.json`, read on every page refresh. See [Merging delegated by the owner](#merging-delegated-by-the-owner).
- **What Auto Release waits for:** `autoReleaseDecision` in the supervisor's `config.json`, read on every page refresh. It is optional: one GitHub issue link, for example `"autoReleaseDecision": "https://github.com/example-org/aiworks/issues/33"`. Settings › Release mode shows it as the release decision that Auto Release waits for. Without it, or with anything that is not a GitHub issue link, Auto Release keeps the same text and shows no link. The review fixture sets none, so a reviewer's page names no real issue.

### Merging delegated by the owner

The owner decided that a pull request which passed the supervisor's independent check of its exact head is merged without an owner step ([#17](https://github.com/example-org/aiworks/issues/17), AGENTS.md "When to stop for the owner"). The dashboard learns this from one setting. It is absent by default:

```json
"merges": {
  "delegatedTo": "monitor",
  "decision": "#17",
  "held": { "https://github.com/example-org/aiworks/pull/88": "newer-work" },
  "stallHours": 3
}
```

- `delegatedTo` names who merges for the owner. `decision` is the owner decision that delegated it, as `#<issue>`. Both are required; without them the setting is ignored.
- `held` is optional. It lists pull requests held from merging, with the reason: `newer-work` reads *Held: waiting to be combined with newer work*. Any other reason reads *Held for now; the pull request says why*. Whoever holds a pull request records it here and removes it when the hold ends.
- `stallHours` is optional, 3 by default. It is how many hours a verified, unmerged, not-held pull request may wait since it passed the check before it comes back to the owner ([#139](https://github.com/example-org/aiworks/issues/139)). It is a whole number from 1 to 720; anything else means 3.

With the setting:

- a verified pull request whose merge is not seen is **not** a Needs you item. No count, project or headline counts it as an owner action;
- the project's Work shows it as *Passed the check*, with *Will be merged for you. Nothing for you to do.* or its held reason;
- Results lists it under *Being merged for you*, as *Pull request #N · passed the check · will be merged for you*, or with its held reason;
- with `"delegatedTo": "supervisor"` ([#138](https://github.com/example-org/aiworks/issues/138)), Work says *AIWorks merges it after it passes the check against the latest main. Nothing for you to do.* and Results *Pull request #N · passed the check · AIWorks merges it after it passes the check against the latest main*. There is no CI step, so no text waits for CI;
- it reads *merged* once a matching supervisor receipt records the verified commit's merge or a current merge check sees it on the base branch. A step with no recorded verified commit stays a Needs you item.

A delegated merge that waits too long comes back to the owner. When a verified, unmerged pull request that is not held has waited longer than `stallHours` since it passed the check, nothing has merged it:

- it is a counted Needs you item, *Check why it is not merged*, with *Checked and waiting to be merged for N hours. Nothing has merged it.* Its one action opens the pull request;
- Work shows the same sentence, and Results *Pull request #N · checked and waiting to be merged for N hours*;
- N is whole hours, rounded down. The time it passed the check is the latest finished check that accepted its verified commit, from the supervisor store. Without a recorded check run, it is when the step last changed, which is never earlier;
- before the threshold, and while it is held, it reads as above. It is never called merged without a matching receipt or a current base-branch check.

This uses the supervisor store and local git only, never the GitHub API.

Without the setting, nothing changes: every verified, unmerged pull request is a *Review and merge* item.

The dashboard only reads this setting. It never merges. Whether the supervisor merges is decided by [AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception) and the owner's own configuration (#138); the `supervisor` wording is ready for it. Setting it on workstation is a configuration change for the owner or the upgrade procedure ([SUPERVISOR.md §6](SUPERVISOR.md#6-installation-and-maintenance)).

### What the dashboard no longer shows

- CI check results and merge conflicts of pull requests, and so *Ready to merge*. Each review item points to the pull request instead.
- Pull requests closed without merging. They read *Published, merge not seen yet*.
- Issues and pull requests that no campaign owns, including governance provider's issue list and tracked extensions.
- Progress of governance provider roadmap items (done, in progress, in review).
- Tracking-issue titles as campaign headings.

These are on GitHub.

Provider credit/rate failures come from execution receipts. Account balances are not queried, and unknown balances are never displayed as zero. Fallback retains the authorized cap and never overrides a permission denial. “Not running” means no operation currently uses that provider; it is not proof of native readiness. A campaign allows one worker slot, so three configured providers do not mean three simultaneous agents. Attempts include recorded refused attempts, while counted runs apply the explicit zero-work refund rule.

Definitions come from governance provider's `docs/PRODUCT_ROADMAP.md`, the PR program in its `docs/AUTONOMOUS_ROLLOUT.md`, and its agent-role catalog `registry/agents.json`, all read from the governance checkout. GitHub owns their work state, and the dashboard does not read it. A planned role is not a running process. Merged is not deployed.

Supervisor state is read from its existing SQLite store with a read-only connection; GET requests never bootstrap a missing store. Runtime refresh is every 5 seconds. Merge checks follow the rules in [Where the data comes from](#where-the-data-comes-from); missing evidence stays unknown and never reads as merged.

## Commands

Controls apply to existing **supervisor-managed campaigns**. Other chat/IDE agents have no command transport attached to this dashboard.

| Command | Effect |
| --- | --- |
| Pause | Stops new dispatch; an existing worker can finish. |
| Pause all work, Pause project, Pause goal | Home, Overview (owner UI v2 WP1). The same pause for every running goal the scope covers, in one transaction. The request lists exactly those goals, each bound to its row version, authorization version and scope digest; a missing, extra or changed goal refuses the whole request with nothing written. A paused goal reads *stopping* while a run it started is still open and *stopped* once none is. |
| Resume all work, Resume project, Resume goal | Resumes only the goals that this very scope paused (for a goal: that goal). A goal paused another way keeps its own Resume and is never resumed by a wider one. |
| Resume | Resumes the private stored declaration with its existing authorization and limits. Current version, scope and authorization are checked atomically. No declaration commit is required. Every Resume, the scoped ones included, first checks that the running dashboard code is part of the trusted main (AW-005): `origin/main`, or with `selfHosting.trustedMain` `"local"` the trusted tip of the main ledger. It never fetches; a refused Resume changes nothing. |
| Recheck | Queues the existing recovery event, for a campaign or a selected unfinished task. It does not force acceptance or bypass owner-reserved conditions. |
| Cancel | Requires a confirmation explaining that the controller terminates its owned workers and that cancelled campaigns cannot resume. Completed results remain available. |
| Send instructions | Select an unfinished task and implementer/verifier role. Up to 2,000 characters are queued for that role's next run on the task; an already running worker is not interrupted. |

Acknowledgement means the command was recorded. A queued recheck/cancel still needs a live controller to act. No command changes authorization, budget, provider order, project scope or declarations; arbitrary shell commands are not executed. These commands register no new campaign. The one way the dashboard starts new work is *Approve and start* on a reviewed plan ([below](#plan-and-do-review-and-approve-and-start-built-off-by-default)).

Free-text guidance is supplemental to the immutable task packet and never changes its permissions, acceptance criteria or independent review requirement. Credential-like text and control characters are rejected. There can be five pending instructions per task. Delivery is committed atomically with an admitted operation and recorded in its immutable prompt; a preflight failure leaves instructions queued. Receipts distinguish queued, attached to a specific run, outdated authorization, and no future run. "Attached" does not claim the model has read or followed it, or that the run succeeded. If that run fails, the owner can inspect its outcome and send guidance again. Older controllers cannot deliver instructions; upgrade the controller to this change before using this command. Drafts survive polling and are cleared only after an accepted receipt.

Commands use the existing supervisor APIs within one transaction. The request is bound to campaign row version, authorization version, scope digest and, for task recheck, task version. Changed state returns a conflict. A durable request ID is bound to the exact payload; repeating it acknowledges the original command without applying it twice. Commands and receipts use the existing events/journal tables.

## Project tabs (owner UI v2 navigation)

A project opens on its tabs, as [Owner UI v2 section 2](design/OWNER_UI_V2.md#2-navigation) designs them (`src/dashboard/public/router.mjs`). They fit at 320px without horizontal scrolling.

| Tab | Address | What it holds |
| --- | --- | --- |
| Overview | `#/p/<project>` | The current goal and its strip, results waiting for review, the **Budget** line with what this project spent (the former Cost tab, its breakdown per piece of work and step under *See the breakdown*) and a link to Settings › Usage, and **Running work**: the AI workers working and each piece of work's steps, under *Details* (the former Work tab). A step opens its own screen. |
| Plan | `#/p/<project>/plan` | The Now / Next / Later board with each plan's versions and drafts; Plan work and a plan's Review (`#/p/<project>/review/<plan>`) belong to it. |
| Review | `#/p/<project>/review` | Results grouped by state, the oldest waiting review as the primary action, finished work and Stop all releases (the former Results tab). A result's Review with Accept result and Request changes opens on its step; a step with a result to review belongs to this tab. |
| Releases | `#/p/<project>/releases` | Shown only where a release is configured: once a release is recorded for the project. Its address opens for every project. |
| Knowledge | `#/p/<project>/knowledge` | What AIWorks knows about the product. |

Old addresses keep working: `#/p/<project>/work`, `/cost` and `/now` open Overview, `/results` opens Review, each rewritten once with `history.replaceState`. An unsent draft kept at an old address (step guidance, for example) moves with it to the new one. The owner's word for what waits on them is **Needs you**; the route stays `#/needs`.

## Home, Overview and Connections (owner UI v2, WP1)

Read-only views beside `/api/state` (`src/dashboard/views.mjs`), each built server-side from the same readers and returning allowlisted fields only: codes, counts, times, identifiers and sentences the supervisor or dashboard wrote. No worker text, recorded reason or local path. `/api/state` carries `home`, `overviews` and `connections`, so the page still polls one route.

| Route | Answers |
| --- | --- |
| `GET /api/v2/home` | What changed after the last-seen marker, the first Needs you item, each project in one sentence, and the pause of all work. |
| `GET /api/v2/projects/<project>` | Each goal with Built, Checked and Available to users counted apart (available stays *Not published: release is off* until a release is recorded, *Not known* while one is unknown), its budget, next action and pause. |

A project's Overview also shows the project's **Budget**: all time and this month, what is counted and what is left, from the same `GET /api/v2/projects/<project>/settings` view Project settings reads (read again every 30 seconds while Overview is open), or that no budget is set; it is changed only in Project settings. Each goal with more than one approved version lists **Approved versions**, newest first, from the journal's registration and authorization amendments: when, the limits each recorded and what changed from the version before (limits, AI workers or model routing; the scope cannot change in an amendment), with limits a version did not record said to be unknown. Plan amendments admitted into the goal (`plan_amendments`, none until child admission is switched on) are listed with the steps they added, revised or cancelled. Plan shows the same list under an approved plan.
| `GET /api/v2/settings` | Settings › Connections: AIWorks itself, each AI worker account, where each repository's merges are seen from, and the trusted main with its backup (state codes only, read locally). |
| `GET /api/v2/events?since&cursor&project&type` | Typed events from the journal, newest first: type, time, work, step and project, never the entry's detail. The owner's recorded acceptance of a checked result is its own type, `accepted`; a merge stays `merged`. |
| `POST /api/v2/events/seen` `{ seq }` | Moves the last-seen marker forward (`dashboard-last-seen.json` in the data directory, beside `config.json`); never past the newest entry, never back. |
| `POST /api/v2/pause`, `POST /api/v2/resume` | The scoped pause and resume above. |

The POST routes keep the command rules: exact Origin, the CSRF token, JSON of at most 16 KiB, and only their own fields. Pause and resume alone accept up to 64 KiB, so their largest valid request, 200 goal bindings, is read and checked whole instead of refused for its size; a larger body is refused before it is read, and nothing changes. The later packages are described in their own sections below: decisions (WP2), the plan model and Plan (WP3), Review of a result (WP4), project settings (WP5), alerts (WP6), previews (WP7) and Knowledge (WP8). Releases (WP9) and remote access (WP10) are not built.

## Decisions (owner UI v2, WP2)

A step stopped for the owner (a B3 stop, or a checker that still rejects after its repair rounds) is a decision. Needs you lists it with an **Answer** link to its step, where the owner chooses an option, writes an answer, asks to be reminded later, or says it did not need them. When the worker's validated result carried a `decision` field (`src/supervisor/adapters/claude.mjs` `DECISION_SCHEMA`), the step shows its question, each option with its consequence, AIWorks' suggestion and why, what continues meanwhile and what happens without an answer, each through the credential filter. Without one, the stop stays a free-text decision answered in the owner's own words. Raw worker text is never shown.

| Route | Effect |
| --- | --- |
| `POST /api/v2/decisions/answer` `{ option?, text? }` | Records one answer per decision. The controller then clears exactly that stop, resolves its blocker record and gives the step's next builder run the answer as guidance under the unchanged packet. |
| `POST /api/v2/decisions/snooze` `{ snooze: 1h, 4h or 1d }` | Feedback only: the item says until when and moves to the end of Needs you; it stays counted, because the step stays stopped. |
| `POST /api/v2/decisions/not-needed` `{ text? }` | "This did not need me", once per decision. Feedback only. |

Each runs the caller check first, like every protected owner action: a request from a program AIWorks started (`APPROVAL_FROM_AIWORKS`), or one the check cannot place (`APPROVAL_UNCHECKED`), is refused with nothing recorded, so no worker can answer, snooze or dismiss an owner decision. The step, campaign, authorization and scope binding, the request id and the once-per-decision rules are unchanged.

**Risk and phone.** Each step shows its risk: *Low*, *Medium* or *High risk* from the risk indicator AIWorks's routing recorded on the step's runs (R0, R1, R2), *High* when the approved plan marks the step or goal high risk, or *Risk not known yet* when neither is recorded, never low by default. On a touch screen at phone width (`(pointer: coarse) and (max-width: 640px)`) a high-risk step's decision shows its question, options, consequences and suggestion, says it is answered on a computer and offers only Remind me later; a desktop browser at 320 px keeps every control. The server's decision rules are the same on every screen.

**What a stop offers.** A step stopped at its repair limit, for a change inside a protected area or for another change outside its plan says what can be done and offers only what the existing authority supports: answering the decision or Check again retries the step once more under the same plan, limits and protected areas; a smaller step, more repair rounds, another protected scope or more files is a new plan the owner compares and approves on Review. A rejected or held result is never accepted, published or allowed once from the dashboard.

Home shows the same card under its first Needs you item when that item is a decision with a question still open, so the owner can answer, snooze or say it did not need them without leaving Home; the unsent answer is a draft of Home's address. Its requests are the ones above.

Each request carries a request id and binds the goal's version, authorization version and scope digest, the step's version and the decision's id (`src/supervisor/decisions.mjs`), so a stale, wrong-step or replayed request changes nothing. The controller checks the decision again when it applies an answer: if the step stopped again meanwhile, the answer clears nothing and gives no guidance. An answer never touches the goal's own blocker, another step, a limit or the plan; a wider change needs a new plan approval. The owner's words stay in the decision's event and never reach the journal.

## Review of a result (owner UI v2, WP4)

A finished step shows its review on the step screen; a project without GitHub shows it under each result on Results. It is built from the verifier's accepted verification of exactly the step's verified head and report (`src/supervisor/result-review.mjs`). A verifier may return `verdictSummary`, `criteria` (one entry per acceptance criterion: pass, fail or not-checked, what it checked and the evidence) and `eyesOn` (where the owner's own judgement matters); they are optional, schema-validated (`src/supervisor/adapters/claude.mjs` `CRITERIA_SCHEMA`) and served bounded and through the credential filter, never as a raw log. A criterion the verifier did not report is **Not checked**, never a pass, and a verdict of `accepted` with a failed criterion is an invalid result.

| Route | Effect |
| --- | --- |
| `POST /api/v2/results/accept` | GitHub results only. Records the owner's acceptance of that verified head, once. It never merges, pushes or reads GitHub: the head merges only through the supervisor's merge gate, in a repository the owner opted in, or under the project's own gate. Refused while a criterion failed or a blocking finding is open. A local result is accepted with Apply, under its existing rules. |
| `POST /api/v2/results/request-changes` `{ text, criterion? }` | Code results only. Records the owner's request once per verified head. The supervisor reopens the finished step as a repair round on its own branch, counted against `maxRepairRounds` (past it the step stops), holds that head from the merge gate meanwhile and publishes only a freshly verified new head. |

Both run the caller check first, like every protected owner action: the dashboard's process lookup must place the request outside every program AIWorks started (`APPROVAL_FROM_AIWORKS`), and without a lookup the request is refused (`APPROVAL_UNCHECKED`) with nothing recorded. The running dashboard (`main.mjs`) gives the native Windows lookup.

Review opens from three places, each with the same project, goal and step: a result row on Results (*Review and accept* while it can be accepted, *Review result* otherwise; the oldest result waiting for review is the screen's primary action when its check is recorded), *Results to review* on Home across projects, and the same list on a project's Overview. A row the owner accepted says when; one seen merged in local git offers nothing to accept, as its Review says. Accepted is said only from the recorded acceptance, never from a merge, and Home's change feed lists it as *You accepted a checked result*.

Both bind the goal's version, authorization version and scope digest, the step's version, the verified head and the digest of the report it was checked with, so a changed, unverified, merged, stale or replayed request is refused and records nothing. Earlier runs, checks and acceptances stay in the record. A finished goal is never shown as complete while one of its results has a criterion failed or not checked, a blocking finding, or changes requested: it reads *All steps are finished, but not complete*, and its merged work is not called ready for release. The owner's words stay in the request's own event: the repair packet carries them to the builder and its verifier, and the comment on the pull request or review item says only that changes were requested.

## Plan and the idea-first start (owner UI v2, WP3 and screen 1)

**Plan** (`#/p/<project>/plan`, the project's Plan tab, also linked from each Review) lists the project's plans grouped **Now**, **Next** and **Later**, with plans AIWorks is still drafting apart. Each shows its state in Review's words, its priority, version and estimate, a link to Review, and **Versions**: every stored draft version, newest first, with who made it (*Drafted by AIWorks* or *Your edit of version N*), when, its goal, Now, Next or Later, and how many parts changed from the version before, saying when the scope changed. It reads the plans `/api/state` already carries under `work` (`src/dashboard/work.mjs`, from `work_drafts` only); there is no other plan store. *Edit plan* opens Review with the edit begun from the version shown, as a draft of Review's address, so Back to Plan says *Continue editing* and nothing is saved twice. Moving a plan between Now, Next and Later is an edit, saved as the next version. Approve and start stays on Review, for exactly the version it shows. A plan that went out of date says so on Plan too. A request no planning run has started for yet reads *Received, not drafted yet*, not *Drafting a plan*: queued, waiting for budget, or waiting to try again after a read that could not draft it (GitHub not reachable, the project's latest version not readable, a usage limit and so on, by its code and the time of the next try). *Drafting a plan* is said only while a planning run is recorded for it.

**Start from an idea.** With Add project on, its screen first asks *What would you like to build?*. The idea is only a draft of that page: it goes nowhere by itself, and AIWorks creates no folder, repository or other project for it. The owner chooses and connects a folder (new or empty is fine) exactly as below; the idea then becomes that project's unsent Plan work goal, unless one is already typed there. The project's rules are confirmed on its Overview, the plan is asked for under Plan work and approved on Review. Nothing is drafted until the owner asks for a plan, and nothing runs before Approve and start. Home with no projects links to Add project while it is on.

## Project settings (owner UI v2, WP5)

**Project settings** (`#/p/<project>/settings`, linked from the project's Overview) holds the standing rules of every goal in one project: protected areas (folders or files AIWorks must never change), notes for the AI, an optional all-time and monthly budget in dollars and, for a project with a merge gate, who accepts results (`src/supervisor/project-settings.mjs`). Each save is a new version in the append-only `project_settings` table; the screen says which version is applied and, for each period, what is counted, what is left and how many runs had no reported cost. Empty budgets mean no limit.

| Route | Effect |
| --- | --- |
| `GET /api/v2/projects/<project>/settings` | The applied version, its settings and the project's spend. A project without GitHub has settings once its rules are confirmed. |
| `POST /api/v2/projects/settings` `{ requestId, project, version, protectedAreas, notes, budget, acceptance? }` | Runs the caller check first, then saves the next version only if `version` is still the newest (`SETTINGS_CHANGED` otherwise, and the page keeps every entry). A repeated request id answers with the version it saved. `acceptance` is `"automatic"` or `"owner"`; a request without it keeps the saved mode. |

**Accepting results** ([AW-015](DECISIONS.md#aw-015---acceptance-controls-merging-when-the-owner-chooses-it)) says in plain words which mode applies: *Automatic* (the default, today's behaviour: a checked result merges under the merge gate without waiting) or *I accept results myself* (a checked result merges only after the owner accepts exactly that version). It is one more field of the same versioned settings, saved only by the owner under the same caller, version and request id rules. In the owner's mode every checked, unmerged version waits in **Needs you** as *Accept or request changes*; the item opens the step's Review, where Accept result and Request changes bind the verified head and report as before, and Review says the version waits for the owner. Such a version is listed as waiting for the owner's review, never as being merged for them. A project without GitHub has no such setting: Apply is its acceptance.

Above the form, **How work runs** explains, read-only, what AIWorks does after Approve and start, how a step that needs the owner asks with a decision, that anything wider is a new plan version the owner approves, the limits each running goal of the project was approved with (steps at a time, AI worker runs, repair rounds and retries per step, reported dollars, price of a run with no reported cost, from its declaration) and what AIWorks never does: change a protected area or leave its plan (there is no "allow once"), widen a goal by itself or from an answer, merge an unchecked version or outside the merge gate, release from the dashboard, read secret files, route around a refused permission or buy an AI account, use GitHub Actions or paid GitHub features, or answer beyond this computer. It offers no control of its own.

Settings only add protection and limits. They have no field for files to change, providers, release or authority, and saving them never changes a registered goal's declaration, authorization version or scope digest. A plan, or a new authorization version, whose declared writes lie inside a protected area is refused (`PROTECTED_AREA`); a commit that changes one is a boundary violation held for the owner, checked when it is built and again when it is checked. A goal keeps the areas in force when it was registered, so removing one later never loosens running work. A budget needs the price a run with no reported cost is counted at; that price is also reserved for every running step, so unknown cost is never zero. No step starts while the budget left, all time or this calendar month (UTC), is less than one run at that price: the goal waits for the owner with a budget decision and continues by itself once the budget allows. Planning counts too: each read that drafts a plan for the project, retries included, is charged like a step, and a plan request the budget cannot cover waits (Waiting for budget) and is read by itself once the budget allows, without holding up other projects. A coordinator read that names no single project is charged to no project; Settings shows it apart.

## Alerts (owner UI v2, WP6)

**Settings › Alerts** (`#/settings/alerts`) holds the owner's alert rules (`src/supervisor/alerts.mjs`): which notices alert them (Action required B2, Decision required B3, External wait B4, Incident B5), whether reminders do, and optional quiet hours in a named time zone, with a choice to let incidents through. Nothing saved means B2, B3 and B5 with reminders and no quiet hours. Each save is a new version in the append-only `alert_rules` table. The screen also says, from the operator's `config.json`, whether an alert transport is set up, counts the notification outbox by state, shows a fictional example alert with what the current rules would do with it, and lists the last alerts the rehearsal transport recorded.

| Route | Effect |
| --- | --- |
| `GET /api/v2/settings/alerts` | The applied version and rules, whether quiet hours apply now, the transport's state (`unconfigured`, `rehearsal`, `ready`, `incomplete`, `unavailable` or `invalid`), whether it is sending, outbox counts (pending, sending, rehearsed, delivered, unknown, failed, muted) and recorded rehearsals. Never a secret store reference or a credential. |
| `POST /api/v2/settings/alerts` `{ requestId, version, rules }` | Runs the caller check first, so no program AIWorks started can mute the owner's alerts, then saves the next version only if `version` is still the newest (`ALERTS_CHANGED` otherwise, and the page keeps every entry). A repeated request id answers with the version it saved. |

Delivery reads **unavailable** until a transport is set up. The synthetic rehearsal transport records alerts on this computer and never reports a delivery. Telegram, the one adapter that leaves this computer, reads `ready` once the operator names its bot credential and chat as secret store references, and sends only while the operator has also switched sending on; an alert that may have arrived is counted as *arrival unknown* and never sent again ([SUPERVISOR.md §10](SUPERVISOR.md#10-owner-intervention-core)). An alert carries no authority. Its buttons are dashboard addresses on this computer (*Decide in AIWorks* or *Open in AIWorks* open Needs you); an answer is given only on the dashboard, through the decision routes above with their CSRF token, request id and goal, step, authorization and scope binding. The dashboard stays on loopback and accepts no reply from a transport; the Telegram adapter reads none.

## Preview of a checked version (owner UI v2, WP7)

A finished step's review offers **Try this version**: the static web pages of exactly the commit that passed the independent check, in a frame at desktop or phone (390 px) width, with that commit named beside it. **Open preview** sends the same binding as Accept result (goal version, authorization version, scope digest, step version, verified head and report digest) and nothing else, so a changed, unverified, reopened or report-only result is refused with its reason; the page says why a preview is not available instead of offering it.

| Route | Effect |
| --- | --- |
| `POST /api/v2/results/preview` | Opens a preview of that verified head. Answers its address under `/preview/<token>/`, the commit and when the preview ends; never a folder. |
| `GET /preview/<token>/<file>` | One file of that preview, or 404, or 410 once it has ended. |
| `POST /api/v2/results/preview/capture` | The same binding. The caller check runs first; then desktop and phone screenshots of that verified head, each with its screen size, the page's layout viewport as the browser measured it, the commit and when. |

The pages are read from the commit's Git objects in AIWorks's own checkout (`src/supervisor/preview.mjs`): nothing is built, installed, started or written, and nothing a request names is run. A preview serves only the folder of the first of `index.html`, `public/index.html`, `site/index.html`, `docs/index.html` or `www/index.html` in that commit, by exact path; dot segments, encoded separators, links, submodules, hidden files, secret-like names, credential-looking text and unknown file types are never served. Every response is a sandboxed document with an opaque origin (`sandbox allow-scripts`, `connect-src 'none'`, `form-action 'none'`, framed only by the dashboard), so its script cannot read the dashboard, its token or its commands, send requests, submit forms or open windows. A preview lives in the dashboard's memory only, for 30 minutes, at most four at a time, and ends when the dashboard stops. It also ends as soon as its version stops being the step's checked one: each open preview checks the review again at most once a second, so a reopened step, one sent back for changes or one checked again at another head answers 410. At phone width the frame keeps a 390 px page and scales it down in a narrower window, and says so, so a 320 px dashboard still shows the page as a phone lays it out.

**Capture screenshots** (`src/supervisor/preview-capture.mjs`) shows desktop (1366 × 900) and phone (390 × 844, touch, mobile viewport rules) screenshots of the same commit below the frame. It needs `commands.chrome` in `config.json` (the absolute Chrome executable web acceptance already uses) and Windows; otherwise Review says why it is not available. Nothing in the request names the executable, an argument, a path or a revision: the binding is checked as for opening, and every argument is fixed in source. The browser:

- runs under `runner.mjs` inside a Windows Job Object, with a fresh profile, home and temporary folder in its own work folder under the dashboard's data folder and no environment beyond what Windows needs to start a process;
- loads pages only from a server of their own on a random loopback port that answers only that preview's files, each request checked again against the review; the same server is its only proxy, so the dashboard and every other address are refused there, a DevTools request filter fails them before they are sent, and WebRTC has no UDP path. Each page keeps the preview's sandbox policy;
- is stopped with its whole process tree after 90 seconds, when the owner's page goes away, when the dashboard closes, or once the screenshots are taken. A screenshot is answered only when the job that held the browser is proved empty and the page was still the preview's own; a page that navigated away is not captured. If the dashboard itself dies, the job still kills the browser at the deadline.

One capture runs at a time. Screenshots are answered to the page and kept in its memory only, beside the preview, and are dropped when the preview is closed or its version changes; they are evidence of what this computer showed for that commit, not of a deployment.

Only static pages are supported. A version without one of the entry pages above that has an app manifest (`package.json`, `pyproject.toml`, `go.mod` and similar) is reported as needing its own server, which AIWorks does not start: a Job Object bounds a process's lifetime and tree, but nothing on this platform keeps an arbitrary program's network to loopback or its file reads to its checked worktree, and installing its dependencies runs their scripts too. That runtime class stays unavailable until such containment exists.

## Knowledge, sample project and usage (owner UI v2, WP8)

A project's **Knowledge** screen (`#/p/<project>/knowledge`, linked from its Overview) lists product facts in three kinds that never change by themselves: **Confirmed by you**, **Found in material** (a sentence quoted from the first paragraph of the project's README, named with the file and the commit it was read at) and **Suggested by AI** (what a plan the AI wrote says its goal delivers, named with that plan and its version). Suggestions are derived when the page reads them and say "Not confirmed"; the owner confirms one, edits it into their own words, or sets it aside so it is not suggested again, and can add a fact of their own. Each act is a new version in the append-only `project_facts` table; a confirmed or edited suggestion keeps where it came from in every later version, and the history lists every version. Only a project's own README (AIWorks's copy at its recorded baseline for a project without GitHub, the configured checkout's `HEAD` for a GitHub project, read from Git objects only) and its own plans are read, and an act names a suggestion only while that project makes it. Facts are not given to workers and carry no field for files, providers, budgets or release, so they never change a plan or its authority.

Below the facts, Knowledge shows what the project's approved goals already record, none of it a fact by itself (`src/supervisor/knowledge.mjs` `projectEvidence`): **Requirements and decisions**, each goal's done-when criteria as its approved declaration states them, marked *In an approved plan* with that goal, its approved version and when, and the owner's recorded answers to step decisions (which step, when, the option chosen or *in your own words*; the words stay in the decision's event); **Materials**, the README commit the suggestions were read at and the repository-relative documents the approved steps name, by path and section only, never opened for the page (a name that is not a plain relative path, or looks like a secret, is counted and not listed); and **History**, the project's last 20 typed events (`GET /api/v2/events`). A criterion that looks like a credential is left out.

| Route | Effect |
| --- | --- |
| `GET /api/v2/projects/<project>/knowledge` | The owner's facts with their history, and the open suggestions with their origin. |
| `POST /api/v2/projects/knowledge` | `{ requestId, project, action: add, confirm, edit or retire, fact or suggestion, version, text }`. The caller check runs first; it binds the version shown and the request id; a credential-looking fact is refused. |
| `POST /api/projects/sample` | `{ path, requestId }` (Add project switched on only). Writes the fictional **Sample notes (practice)** app into a new or empty folder after the same folder check as Add project, then connects it like any folder. |
| `GET /api/v2/settings/usage` | Settings › Usage. |

Add project (First run) states first what planning a goal has cost: the range and typical dollars of the last 20 finished planning runs that reported a cost, with the others counted apart, or "unavailable" while none did. It also offers **Practise on a sample project**: a folder holding anything else is left alone, a refused folder is removed again if AIWorks created it, and the same folder again opens the same project. The sample starts nothing: its rules, a plan and its approval wait for the owner as for any project.

**Settings › Usage** shows AI worker runs (reported dollars, tokens per provider, runs with no reported cost) and the AI coordinator (planning and messages) by unit, each apart and never added together; a run that reported no cost reads "unknown, not $0". Hosting and subscriptions are not tracked by AIWorks and say so, with no amount.

## Releases (owner UI v2, WP9)

A project's **Releases** tab (`#/p/<project>/releases`, shown where a release is configured) answers what reached users and what can be undone, from the release rows only (`src/supervisor/release/state.mjs`; Auto Release is built switched off, so on an install today it lists none and says so). Per release: the destination (id, environment and kind), **What changes for users** (the step's outcome with its change classes and file count, never the paths), the version (checked commit, merge commit, live digest, grant version), **Restore** (the previous version through the project's rollback command and a new check, report-only, no rollback command, a revert pull request, a backup, nothing changed, or unknown for a row recorded before AIWorks kept its destination; only the released version is restored, never data the site stored) and **Health** (the latest of the post-release check, the check after a rollback and the owner's own check: healthy, failed, unknown, checking or not checked; unknown is never healthy). Below, each checked result keeps Checked, Merged, Live, Release checked and Accepted by you as separate answers. **Publish a checked version** is shown not available with what is missing; there is no Publish button, and no form chooses a destination, command or grant.

**Check the site now** appears on a settled release only when the release role may run it: `release.enabled` true, no `RELEASE-STOP`, a destination with a `check` command and no check already running; otherwise the screen says why. It runs `src/supervisor/release/health.mjs`, which reads the grant again at the ref and path the release recorded and runs only that destination's `check` command through the release runner, once. The answer (passed, failed or unknown) is kept beside the release and journalled; the release's state and lock never change and nothing is rolled back.

| Route | Effect |
| --- | --- |
| `GET /api/v2/projects/<project>/releases` | The project's recorded releases, Publish's missing conditions and its checked results, allowlisted. |
| `POST /api/v2/releases/check` | `{ requestId, releaseId }`. The caller check runs first; 409 with the exact reason when it may not run; nothing changes then. |

## Plan and do, Review and Approve and start (built, off by default)

**In short.** For a connected GitHub project, the owner asks AIWorks for a plan, reads it on **Review** and presses *Approve and start*. That registers exactly the plan on the screen, with the same checks as the command-line start. No command line is needed. (Design: [OWNER_WORKSPACE S10](design/OWNER_WORKSPACE.md#s10-review-and-approve-github-projects) and WORK_ENVELOPE slice E8 ([§12](design/WORK_ENVELOPE.md#12-implementation-slices)); build slice UI14 of [the plan](PROJECT_WORKSPACE_PLAN.md). The owner answered #32 on 2026-10-16: approving in the dashboard registers that exact plan.)

- **Off by default.** Plan and do appears on Start work only while the data directory's `config.json` switches drafting on (`"coordinator": { "intake": true }`), and only for a connected GitHub project that is ready to start work. Without it, Start work offers Plan only, as before. The dashboard reads the setting on every request. Like any runtime change, it goes through the upgrade procedure ([SUPERVISOR.md §6](SUPERVISOR.md#6-installation-and-maintenance)).
- **Asking.** *Plan and do* stores one work request (`src/supervisor/intake.mjs`). It registers nothing. The receipt says AIWorks is drafting; once the draft is stored, it links to Review. Start work also lists the project's plans.
- **Review.** It shows the result, the goal as asked with Now, Next or Later and its priority, the done-when criteria each with how it is checked (or *how it is checked is not stated*), what is included and what waits for later, the estimate (*No estimate* when nobody made one; never zero), the main steps, overlaps with other work, what the plan may change, the AI workers and limits, and *Release: Review only*. Details holds the plan text, its fingerprint and its version. The coordinator may propose the check methods, included and later items and an estimate (`outline` in `src/supervisor/coordinator.mjs` `INTAKE_SCHEMA`); Now, Next or Later and the priority are the owner's, and a draft starts in Now at normal priority.
- **Edit plan (owner UI v2, WP3).** On a ready plan nobody approved yet, *Edit plan* opens a form for the result, Now, Next or Later, priority, the criteria and their checks, included, later and the estimate. Saving (`src/supervisor/intake.mjs` `reviseDraft`) makes the next draft version; nothing is approved or started. What the work may change, protected paths, AI workers, limits, release, the target and the pinned project version are copied from the edited version unchanged, and a request to change one is refused (`SCOPE_NOT_EDITABLE`): a wider scope, more budget or another release needs a new plan. The save names the version and digest it was made on, so an edit of a plan that changed meanwhile, went stale or was already approved is refused with nothing written; a repeat with the same request ID is saved once. The unsent edit is kept per address through the refresh, a reload and Back; when the plan changes meanwhile the form says so, keeps the edit and offers to apply it to the new version. Approve and start is not offered while an edit is open. Review then shows *Changes from version N*, with any scope change set apart. Approving an earlier version than the one shown is refused (*This plan changed since you opened it*), and the start transaction checks again that the approved version is still the newest.
- **Approve and start.** The page sends the plan's version and authority digest as shown. The server (`src/dashboard/work.mjs`) refuses, and keeps or registers nothing, when:
  - another version was drafted, the digest differs, or the stored plan no longer hashes to that digest. The owner reads *This plan changed since you opened it. Review it again.*, stays on Review, and the new version loads;
  - the plan is out of date: the supervisor marked it stale, or the project's base branch moved since drafting. The dashboard fetches the base branch again with `git`; if it cannot be read, nothing starts (unknown is never fresh). It never runs `gh`, so an edited issue or a moved pull request is caught only by the supervisor's own freshness check;
  - any check the CLI `start --approved` makes fails, in its order: merged runtime code (AW-005, `RUNTIME_NOT_MERGED`), the project listed in the project rules, the declaration rules, the duplicate-work check (`WORK_ALREADY_ASSIGNED`) and the private store. The owner reads *AIWorks didn't start this work: {reason}.*; Details keeps the machine's code.

  Otherwise the private approval and the plan are kept with `persistApproved` and registered with `registerApproved` (`src/supervisor/approved-declarations.mjs`) in one transaction. The page opens Work with *Approved at 12:40 · waiting for AIWorks to pick it up*. A repeat with the same request ID is acknowledged once; a second approval of a started plan is refused.
- **Projects without GitHub.** They follow the next section.

| Route | Effect |
| --- | --- |
| `POST /api/work/requests` | Plan and do: stores one work request (`requestId`, `project`, `goal`, `from`, and `number` or `reportTo`); 409 while drafting is off |
| `POST /api/work/edit` | Edit plan (`requestId`, `plan`, `version`, `authorityDigest`, `edits`): saves the next draft version, or refuses; 409 while drafting is off |
| `POST /api/work/approve` | Approve and start (`requestId`, `plan`, `version`, `authorityDigest`): registers exactly that plan, or refuses |

They keep the command rules: exact Origin, the CSRF token, JSON of at most 16 KiB (64 KiB for an edit, which can hold 48 texts), and only their own fields. `/api/state` carries the plans under `work`, allowlisted fields only, never a path. `tests/dashboard/approve.test.mjs` checks each refusal against the CLI, with disposable repositories and a synthetic `gh`.

## A project without GitHub: plan, approve, review and apply (built, off by default)

**In short.** For a local Git project or a plain folder, the owner confirms the project's rules once, asks for a plan, reads it on **Review** and presses *Approve and start*. AIWorks works on its own copy. When a step passes the independent check, its result waits under **Results** as *Ready for your review*. Nothing in the owner's folder changes until they press **Apply**, and **Undo apply** puts the folder back. No pull request is ever shown, and nothing here calls `gh` or a network service. (Design: [OWNER_WORKSPACE S12 and §5.3](design/OWNER_WORKSPACE.md#53-adding-a-plain-folder-after-s11), WORK_ENVELOPE section 8 and 8.6; build slice UI17 of [the plan](PROJECT_WORKSPACE_PLAN.md#67-lane-ui---owner-workspace). The owner decided on 2026-10-16: rules confirmed once in the dashboard (#24), a dashboard approval admits exactly that plan with no signing key (#32), and a result is applied only when the owner presses Apply.)

- **Off by default.** It needs Add project (`"projectConnection": { "enabled": true }`) and drafting (`"coordinator": { "intake": true }`) in the data directory's `config.json`. Read on every request.
- **Confirm this project's rules.** Until the owner confirms them on the project's Now screen, Now says *Connected. Confirm this project's rules on this page before AIWorks plans or starts work here.*, Start work offers no plan, and Needs you names the project. Expired or revoked rules stop new plans the same way.
- **Plan and do.** Start work offers *Plan and do* from a description only: the project has no issues or pull requests to start from, and nothing reports to GitHub. The draft names the project by its rules' `lp-` id and is a fixed plan (`src/supervisor/intake.mjs`).
- **Approve and start.** The same Review checks as a GitHub plan, then merged runtime code (AW-005) and AIWorks's copy still at the version the plan was drafted from (read from the store, never from the folder). Then the **caller check** runs on the request's connection: a press from a program AIWorks started (`APPROVAL_FROM_AIWORKS`), or one the check cannot place (`APPROVAL_UNCHECKED`), records nothing and starts nothing. Otherwise the owner's approval of exactly that plan goes into the local approval ledger and `registerLocalPlan` admits it once and registers it (`src/supervisor/local-admission.mjs`). A refused registration starts nothing; the owner reads *AIWorks didn't start this work: {reason}.*
- **Work and Results.** Overview lists each approved plan's steps in plain words under *Running work*. Review lists each step's checked result: *Ready for your review* with **Apply**, *Applied to your folder* with **Undo apply**, or why an Apply was refused, with the files.
- **Apply.** The same caller check runs first. Then AIWorks reads the folder again: if any file the result touches changed since AIWorks copied it, Apply is refused with nothing written (`APPLY_FOLDER_CHANGED`). Otherwise it keeps a backup and writes the result (`src/supervisor/release/owner-apply.mjs`). Apply is an owner action under Review only: it creates no release record and needs no release grant. Auto Release stays off (#33).
- **Undo apply.** The same caller check, then the backup is put back where the folder still holds what Apply wrote; over a file changed since, it is refused with the files named and nothing written.
- **How the caller check finds the caller.** The dashboard as `npm run dashboard` starts it (`src/dashboard/main.mjs`) gives the check the native Windows process lookup (`src/supervisor/caller-lookup.mjs`, which runs the hidden helper `windows-caller.ps1`). It finds the one IPv4 loopback connection whose client and dashboard ends both match the request's socket, takes its owner, holds that process open and checks that it was created before the connection and still owns it, then reads its parent chain (each parent held open; a parent created after its child is a reused pid, so the chain ends there, and it also ends at a parent that has exited, because the process recorded above an exited parent, such as a desktop browser's logon processes, is often a protected system process it cannot open) and which open AIWorks run's job object it or a parent is in. Every worker, verifier and coordinator run is in a job its descendants cannot leave, so a descendant whose parent has exited is still refused (`APPROVAL_FROM_AIWORKS`). The check refuses with `APPROVAL_UNCHECKED` when it cannot tell: no single matching connection, a changed pid, a process in the chain it cannot open (such as one started from an elevated or service process), a job it cannot read, a job it cannot see while its runner still runs, a launched run whose `runner.json` does not yet name its complete identity (positive pid, `windows-job-v1` containment, a generated job name and its Windows creation time; the runner's first `{ pid, startedAt }` is not enough), or another platform. The same check guards every protected owner action: project rules, Approve and start, Apply and Undo apply, project settings, alert rules, Knowledge, the work list, Accept result and Request changes, and answering, snoozing or dismissing a decision. Origin, CSRF, request id, version and approval digest checks are unchanged. `tests/supervisor/caller-lookup.test.mjs` checks the lookup on real loopback connections and `tests/dashboard/owner-caller.test.mjs` the production entry point: an independent process saves alert rules; a contained worker's detached descendant is refused with `APPROVAL_UNCHECKED` while its runner.json is still the first `{ pid, startedAt }` and with `APPROVAL_FROM_AIWORKS` once it names the job, and nothing durable changes. Merged is not deployed: a running dashboard uses this lookup only after an upgrade to a revision that includes it.
- **Decisions.** A step of local work that stops for the owner is a decision like a GitHub step's (WP2): Needs you and Home list it under its project, the project's Overview shows it first with the same decision card, and the answer goes through `POST /api/v2/decisions/answer` with the same caller check and bindings. A stop without options shows what the AI worker asked, credential-filtered, since there is no step issue to read it in. A stopped step that is no decision says it will not retry by itself.
- **Cost.** The project budget and Settings › Usage count local work's runs. Not shown yet: a cost breakdown per goal and step, and local work's providers under Settings › AI workers.

| Route | Effect |
| --- | --- |
| `POST /api/work/apply` | Apply (`requestId`, `campaignId`, `taskId`, `seq`): writes the checked result to the owner's folder, or refuses |
| `POST /api/work/undo` | Undo apply (`requestId`, `applyId`): puts the folder back, or refuses |

Both keep the command rules: exact Origin, the CSRF token, JSON of at most 16 KiB, and only their own fields. A repeat with the same request ID is answered, never acted on twice. `/api/state` carries each local project's work and results under `work.local`, allowlisted fields only, never a path. `tests/dashboard/local.test.mjs` checks the flow with a disposable folder and a synthetic process lookup.

## Add project (built, off by default)

**In short.** With it on, the owner adds a project from the Projects screen: a GitHub checkout, a local Git repository or a plain folder. Connecting only reads the folder. A project without GitHub starts work once the owner confirms its rules. (Planned design: [PROJECT_CONNECTION §8](design/PROJECT_CONNECTION.md#8-connect-flows-failure-copy-and-tests) and [OWNER_WORKSPACE §4.11](design/OWNER_WORKSPACE.md#411-add-project-after-project-connection-exists); build slice UI13 of [the plan](PROJECT_WORKSPACE_PLAN.md#67-lane-ui---owner-workspace).)

- **Off by default.** With no `projectConnection` block in the data directory's `config.json`, the Projects screen and `#/projects/add` read exactly as before, and every route below answers 404. Turn it on with `"projectConnection": { "enabled": true }`. The dashboard reads it on every request. Turning it on waits for no owner decision (plan §6.7, UI13 row). Like any runtime change, it goes through the upgrade procedure ([SUPERVISOR.md §6](SUPERVISOR.md#6-installation-and-maintenance)).
- **How it works.** The owner types or pastes a folder path. *Check folder* says what AIWorks found: *Git repository with GitHub remote owner/name*, *Git repository, no GitHub remote* or *Ordinary folder, no Git*. *Connect project* then connects it through the supervisor's project connection API (`src/supervisor/project-connect.mjs`), and the project's Now screen opens. A refusal shows the design's sentence for its code and its one action, such as *Use this folder* or *Check again*.
- **Your folder stays untouched.** Connect runs read-only Git commands and never writes in the folder. A local Git project or plain folder gets AIWorks's own copy outside it, next to the data directory. A GitHub project needs `gh` signed in; connect reads the repository over REST only.
- **Starting work.** On a GitHub project it works as before. On a local Git project or plain folder it starts once the owner confirms the project's rules, as the section above says. A GitHub project that governance provider does not list reads *This project is not listed in your project rules yet, so AIWorks cannot start work on it.*, followed by who decides and where the project rules are.
- **On a connected project.** Its Now screen offers *Check again*. When a local project's folder moved, it offers *Move "{name}" here*; a plain folder first shows how many files match AIWorks's last copy. Under the connection's details sits *Disconnect…*, which deletes no history, copy or worktree.
- **Known limit.** Connecting a large plain folder copies it inside the dashboard's request. The page does not refresh until the copy ends (at most the 120-second scan limit, plus the copy).

| Route | Effect |
| --- | --- |
| `GET /api/projects` | The connected projects, each with its own folder path |
| `POST /api/projects/preflight` | What the folder is; saves nothing |
| `POST /api/projects/connect` | Connects it as `github`, `local-git` or `folder`; the same folder again opens the same project |
| `POST /api/projects/check` | Check again; saves the status |
| `POST /api/projects/relocate` | Move here (a plain folder needs `confirm: true` after the match count) |
| `POST /api/projects/disconnect` | Disconnects; bound to the version the page saw |

The POST routes keep the command rules: exact Origin, the CSRF token, JSON of at most 16 KiB, and only their own fields. The one absolute path a response may carry is the owner's own project root (plan §6.7 and §6.14), and only in these routes. `/api/state` names a project's folder, never its path. Mirror, worktree and data paths are never served.

## Remove a project from Projects

**In short.** A GitHub project whose work is all finished or cancelled, or that has no work, can be taken off the Projects screen: its row's Details offer *Remove from Projects…*, then *Remove*. Only the row goes. Its work, results and history stay in the work records, and `config.json`, the repository and its folder are not touched. The removal is kept in `removed-projects.json` in the data directory and works whether Add project is on or off.

- **Refused** while the project has work that is not finished (paused counts), something in Needs you, a result whose merge is still being checked, or a connected folder (that has *Disconnect…* on its Now screen). The server checks this against the Projects screen as it reads at that moment.
- **It comes back** by itself when new work is registered in it, or when it again has work running or something that needs the owner. Settings › Projects lists the removed projects, each with *Show again*. Its release mode is not listed while it is removed.

| Route | Effect |
| --- | --- |
| `POST /api/projects/remove` | Removes `repository` from Projects, or refuses (409) |
| `POST /api/projects/restore` | Shows `repository` on Projects again |

Both keep the command rules and take only `repository` and an optional `requestId`.

## The local work list (UI20)

AIWorks's own work list ([LOCAL_OPERATION section 5](design/LOCAL_OPERATION.md#5-the-local-work-list)) has its own screens once `selfHosting.repository` is set in `config.json` or the store holds items (`src/dashboard/work-list.mjs`). They sit under Needs you and are reached from it; the global bar is unchanged.

- **Work list** (`#/worklist`): open items, closed ones behind a disclosure, and Add an item (task, note, finding or decision). Each row says its kind, state, who wrote it (you, AIWorks or the GitHub import) and when it changed.
- **Work item** (`#/worklist/<n>`): the title, text and comments, set as text and never as markup, the step it belongs to, the GitHub issue it was imported from, Close item or Reopen item, and Add a comment. The item is read again at every refresh (`GET /api/v2/worklist/<n>`); a comment draft started before the item changed says so. A `review` item says *Local review: passed the independent check on this computer. Not merged and not accepted*, or that it was merged into local main, which is still not accepted.
- **Needs you** lists each open `decision` item AIWorks marked as needing you, counted with the other items and linked to its work item.
- **Results** of AIWorks's own repository shows each checked local review under *Checked on this computer · not merged yet*, or under *Merged* once the local merge gate recorded that commit on main, with its work list link. A step whose result is a local review is no longer listed as a missing link.
- **Imported issues** (`#/worklist/import`): a read-only preview of the issues imported from GitHub that this flow has not closed, each checked by default. *Close N issues on GitHub…* opens a dialog that names exactly those issues and asks for the repository's name; Escape or *Keep them open* sends nothing. The import itself stays `supervisor work-list import`; this screen reads the store only.

| Route | Does |
| --- | --- |
| `POST /api/work-list/items` `{ requestId, kind, title, body }` | Adds an item written by you. |
| `POST /api/work-list/comment` `{ requestId, number, version, body }` | Adds your comment to the item as it was shown. |
| `POST /api/work-list/state` `{ requestId, number, version, state }` | Closes or reopens the item as it was shown. |
| `POST /api/work-list/close-imported` `{ requestId, typed, selection: [{ number, version }] }` | Closes on GitHub exactly the confirmed issues (at most 100 at a time), through SELF11's `closeConfirmedIssues`. |

Each keeps the command rules (exact Origin, the CSRF token, JSON of at most 16 KiB, only its own fields) and runs the caller check first, so a request from a worker or any other program AIWorks started is refused with nothing written or sent. A change binds the version of the item it was sent for: a changed item answers *This item changed since you opened it* and saves nothing; one changed or foreign entry refuses the whole close list before anything reaches GitHub. Each request carries a request id; a retry or a second press with it answers the first result (`duplicate: true`) and does nothing again, and an issue this flow already closed is never commented on or closed again. Text is limited to 4,000 characters and refused when it looks like a credential.

Closing on GitHub is built but switched off (`CLOSE_IMPORTED_ON` in `src/supervisor/work-list-import.mjs`) until the amended AW-001 (SELF12) lands: the preview then says *Preview only* and the route answers that closing is not switched on, with nothing sent.

## Local access boundary

The server binds only to `127.0.0.1`; the local host is the trust boundary. This is not a remote or multi-user authentication service. Do not expose it through a proxy, tunnel or public interface without a separately reviewed authentication layer.

Requests require the exact loopback Host.

**Links from other apps.** Following a dashboard link from another site (GitHub, Telegram, email) is a top-level `GET /` with `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` and no `Origin`, and it returns only the static page. All other cross-site requests are still refused, including:
- `/api/*`, including the CSRF session;
- scripts and styles;
- framing;
- every POST.

The page then loads its data with same-origin requests.

Commands are JSON POSTs with exact same Origin and a per-process CSRF token; foreign/null/missing command origins are rejected. Responses prohibit framing and cross-origin reads. They also set `Cross-Origin-Opener-Policy: same-origin`, so a dashboard page opened from another site shares no window reference with that site. All remote labels/titles render as text and links are constrained to GitHub. Snapshot fields are allowlisted: raw worker output, prompt packets, session identities, local workspace paths, secrets and raw error text are not served. The one exception is a connected project's own folder path, in the [Add project](#add-project-built-off-by-default) routes only. Heartbeat reads are confined to the configured runs directory.

### Speed

A state request reads the whole store in one pass, synchronously, so while it runs the dashboard answers nothing else, not even a static file. It has to stay short as the installation grows (aiworks#49):

- The store indexes each campaign's operations, journal and events (`store.mjs`), so reading one campaign's records does not scan every campaign's. The supervisor adds the indexes when it opens the store; the dashboard only reads, so an older store is faster once the supervisor has run on this code.
- A campaign's operations, merges, acceptances, change requests and reading checks are read once for all its steps, and each project's acceptance mode once per request, never again per step.
- The credential check of a displayed text keeps its verdict for that exact text (by digest) for later requests.
- The page asks for the next timed refresh only after the last one answered, so slow answers never queue up behind each other.

`node scripts/dashboard-speed.mjs [--rounds 3] [--scale 1]` measures this on a disposable synthetic store of a busy installation's size (about 70 campaigns, 200 steps, 650 operations, 5,500 journal rows), with the dashboard of the checkout started as its own process on a free loopback port and stopped afterwards. `--scale` multiplies every size, to see whether the time grows only in proportion. It never reads an installation's data.

## Verification

Completed/cancelled campaigns do not appear as controller failures when their historical leases expire. Their task rows distinguish verified PR/report publication from repository or product completion. They expose provider, dependency-integration and blocker waits with retry times. Execution snapshots are read live every five seconds. The connection label says when a merge check is running or has failed, rather than treating a successful local connection as a fresh remote observation.

Some test files this document names (`merges`, `delegation`, `owner`, `claims`, `presentation`, `connect` and `approve`) describe checks rehearsed before this public history began, or removed under the product-critical test rule of [AGENTS.md](../AGENTS.md#validation); they are not in this repository. The kept dashboard checks are the files in `tests/dashboard/`.

`tests/dashboard/merges.test.mjs` uses disposable git repositories, a synthetic git wrapper and a synthetic `gh`:
- a step whose verified commit is reachable from `origin/main` after a fetch is merged, with its merge commit time; one that is not reads *Published, merge not seen yet*; old data never shows merged;
- `git fetch` runs at most once per repository per 5 minutes, never two at once;
- a failed fetch keeps the last state, shows its age and is not retried for 5 minutes; a repository with no checkout is never fetched;
- the running dashboard (`main.mjs`) makes zero `gh` calls across startup, merge checks and every page and API route, with the synthetic `gh` both configured and first on `PATH`; no dashboard source names the GitHub API;
- a delegated merge that waited past `merges.stallHours` becomes a counted Needs you item from the store and local git alone, with zero `gh` calls.

`tests/dashboard/delegation.test.mjs` checks the delegated merge copy, holds, `stallHours` and the stalled Needs you item with a fixed clock.

`tests/dashboard/dashboard.test.mjs` exercises the roadmap definitions (no GitHub work state, no cache), read-only snapshots, safe metadata, real API transitions, stale/ABA protection, authority preservation, duplicate delivery and HTTP request protections and response headers using disposable data.

`tests/dashboard/owner.test.mjs` exercises:
- the owner view: current local git merge checks, review items, the steps they unblock, churn notes, merges not seen, decisions and an unreadable coordinator inbox;
- the page order: campaigns with something for the owner and active ones first, finished ones collapsed to one line each, newest first;
- `purpose`/`outcome` validation and the unchanged scope digest;
- the host label;
- cross-site link navigation, with `/api/*` still refused.

`tests/dashboard/claims.test.mjs` checks that owner-facing statements claim no more than the state supports:
- a posted report is for the owner to read, and a finished reports campaign shows the supervisor's next action;
- a finished campaign is calm only when every step is merged or a report, including before the first merge check, when a fetch fails and when data is old;
- a missing or unrecognised result link is unknown and becomes a *Check on GitHub* item; only a merge check that can still come shortly keeps *Checking for merges*. A report the supervisor recorded in the local work list (an `aiworks-work:<n>` result link whose item holds the supervisor's comment for exactly that goal, step and report digest; `src/dashboard/supervisor.mjs` `localReport`) is a report to read, linked to `#/worklist/<n>` on Results, the Work tables and its step, never a merge or an acceptance. A link alone, without that comment, stays unknown;
- the dashboard never says *Ready to merge*; it names the accepted commit and points to the pull request;
- restart advice waits for the grace period after the lease lapses, or after registration for a campaign no supervisor has picked up;
- *Merging lets X build on it* names only steps that have not started;
- the calm heading covers only blocking items, and reports to read and merged work ready for release are named apart;
- Needs-you items built from an old or failing merge check say when it is from, and never read as merged;
- a pause by itself is a neutral campaign state, never a Needs-you item, but a paused campaign whose supervisor stopped or never started is listed with the restart action;
- each Needs-you item leads with what its step delivers, with the evidence in one line;
- release wording follows the registry: a recorded standing deploy authorization, else the project's own release policy, and never "your release".

`tests/dashboard/presentation.test.mjs` checks the presentation follow-ups from the live reviews (AIWorks design work):
- campaign titles from declared wording, and humanized distinguishing names;
- views that open at their top, with Back restoring the position;
- provider detail for active campaigns only;
- the neutral host placeholder;
- the explicit page background and large-screen scaling;
- supervisor-fault wording that links where faults are tracked.

`tests/dashboard/connect.test.mjs` checks Add project with disposable folders and git repositories, a synthetic `gh` and synthetic branch reads:
- off by default, every route answers as before;
- the routes keep the Origin, Host, CSRF, JSON and 16 KiB rules;
- a plain folder, a local Git repository and a GitHub checkout connect, and each folder is byte-identical afterwards, `.git` included;
- every code's copy matches PROJECT_CONNECTION §8;
- no response names a path other than the owner's own project root;
- the two-project acceptance (§8.5);
- Check again, Move here and Disconnect;
- a keyboard-only connect through the page, and the 320px rules.

No verification command pauses or cancels a live campaign.

Run the focused suite with `node --test tests/dashboard/dashboard.test.mjs`, then the repository gate with `npm run check`.
