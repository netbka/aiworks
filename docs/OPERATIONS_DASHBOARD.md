# Operations dashboard

Owner request, 2026-10-09: see the entire roadmap, completed and ongoing work, and send basic commands to agents. First delivered in Engineering Platform ([#60](https://github.com/netbka/engineering-platform-archive/issues/60)); the owner view is tracked in [netbka/aiworks#4](https://github.com/netbka/aiworks/issues/4). This is the local operations surface for the AIWorks delivery supervisor. It is not Engineering Platform's project portal.

## Run

Requires Node 22.5 or newer and the existing authenticated `gh` CLI. From this checkout:

```sh
npm install
npm run dashboard -- --data D:/Git/aiworks/.local/supervisor --governance D:/Git/aiworks/.local/governance
```

Open **http://127.0.0.1:4318**. Optional arguments are `--port`, `--cache` and `--governance`; the default metadata cache is `.local/dashboard-cache`. `--governance` names the governance checkout and defaults to `governanceRoot` in the data directory's `config.json` ([SUPERVISOR.md §6](SUPERVISOR.md#governance-checkout)). Without one, the roadmap panel says "governance checkout not configured". Launch background instances with a hidden process, as required by the Windows command-window rule. On HomePc it runs as the per-user task `AIWorks Dashboard`. Starting the dashboard does not start, pause, resume, upgrade or restart the supervisor.

## Ownership and updates

The dashboard (`src/dashboard`) and delivery supervisor (`src/supervisor`) belong to the AIWorks repository. GitHub branches and PRs hold unmerged work; merge status remains in GitHub rather than this runbook.

The active local service uses a detached, reviewed checkout at `D:/Git/aiworks/.local/runtime`. Updating the main development checkout does not change that running version; upgrade the pin using the [supervisor procedure](SUPERVISOR.md#upgrade). Local state lives at `.local/supervisor`, generated target worktrees at `.local/worktrees/<repo>` and the governance checkout at `.local/governance`, relative to the AIWorks root. `.local/` is ignored by Git and is not part of a source update. Target checkouts remain at `D:/Git/<project>`. See the [supervisor layout and relocation procedure](SUPERVISOR.md#6-running-on-homepc).

## What the owner sees

- Overview: **Needs you** first, then a card for each campaign that has something listed for the owner or is still active, then live agents and roadmap progress. Finished and cancelled campaigns with nothing listed come after that, as one line each.
  - **Needs you** is built from supervisor and GitHub fields, never from worker output. It lists:
    - finished steps whose pull request waits for the owner's review and merge, with the steps that build on them and any step that took many tries;
    - pull requests closed without merging;
    - owner decisions and stopped steps;
    - a supervisor that is not running;
    - a coordinator that cannot read messages;
    - a finished step whose result GitHub cannot confirm. It has no recorded result link, or its pull request is missing from the data GitHub returned. The item says *Check on GitHub* and links the step issue.
    
    A link to the coordinator's latest answer sits under the list. The **Needs you** metric counts these items. A finished step whose GitHub state is not loaded yet, or cannot be read right now, is shown as unknown (`?`), never as nothing. The heading then says *Checking GitHub…*, but only for state a refresh can still bring.
  - **Each step item leads with its subject.** There is one item per step. The item starts with what to do (*Review and merge*, *Closed without merging*, *Decision needed*), then what the step delivers (its declared `outcome`, else its title) and an *Open PR* or *Open step issue* link.
    - The merge evidence is one compact line, such as *Checker accepted the head · no conflicts · no CI checks ran*. Opening it shows the full sentence.
    - The repository and campaign follow in small text.
  - **A pause is not an owner item by itself.** The store does not record who paused a campaign, so the dashboard does not guess from the reason text. The campaign card shows the pause in a neutral state: the chip reads, for example, *Supervisor running · campaign paused*, and the banner gives the time and the reason as given. A blocker or a stopped step in a paused campaign is still listed.
    - A paused campaign still needs a running supervisor, because the controller renews its lease too. A stopped or absent supervisor is listed once the 5-minute grace period has passed:
      - *The supervisor on &lt;host&gt; stopped while &lt;campaign&gt; was paused*, with the restart action, for example when an upgrade paused campaigns and the restart failed;
      - *The supervisor on &lt;host&gt; has not started &lt;campaign&gt; yet (it is paused)*.

      The card's chip then uses the warning tone, and the banner names the stopped supervisor.
  - **Calm text covers only blocking items.** With no item and no unknown GitHub state, the heading says *Nothing is blocked on you right now*, never "nothing needs you". Reports to read and finished campaigns whose merged work is ready are not blocking. When they exist, a line names them, for example *Also: 2 reports for you to read · merged work in Dyk is ready; release follows its standing deploy authorization*. The metric says the same in short form.
    - The dashboard has no read or release state. The line counts reports that were posted and merged work that is ready, not what is still unread or unreleased.
  - **Release follows the project's registry entry.** The dashboard does not assume the owner releases.
    - Where a project records a standing deploy authorization (`governance.releaseAuthorization`, [GOVERNANCE_INHERITANCE §9](https://github.com/netbka/engineering-platform/blob/main/docs/GOVERNANCE_INHERITANCE.md#9-machine-readable-inheritance-state), [EP-029](https://github.com/netbka/engineering-platform/blob/main/docs/DECISIONS.md#ep-029---standing-production-deploy-authorization-keeps-every-release-gate)), release sentences say *release follows Dyk's standing deploy authorization*.
    - Otherwise they say *release follows &lt;repository&gt;'s release policy*.
    - The registry is read once at dashboard start from the governance checkout.
  - **Finished campaigns** with nothing listed for the owner collapse into *Finished campaigns (N)*, most recent first. Each has one line saying where its results stand and a *See all steps* disclosure. A finished or cancelled campaign card shows no controls. The Agents page uses the same order.
  - **Stale GitHub data in Needs you.** An item built from GitHub data says *GitHub data from 12:31; refreshing* when the data is not fresh:
    - it is older than 5 minutes;
    - it came from the cache read at startup and no fetch has succeeded since;
    - or the last refresh failed. The note then says *the last refresh failed, retrying*.

    Such data never supports *Ready to merge*.
  - **Campaign heading:** declared wording first.
    - It is the campaign's `purpose` or, for a campaign of one step, that step's `outcome`, else its title.
    - Otherwise it is the tracking issue title.
    - Campaigns that share a heading get a distinguishing name in parentheses, built from the words of their ids that differ. Issue numbers are dropped (*Open runtime PRs*, *Design contracts*) unless names would otherwise be the same.
  - **Each step:** the declared plain-language `outcome` first (the slice title is secondary) and where it stands for the owner: *Waiting for your review*, *Merged*, *Closed without merging*, *Report posted* or *GitHub state not known yet*. A step that took 5 or more tries, or was rejected by the verifier, carries a "Took N tries" note. This is information only and never a limit.
    - The line under an unknown state says why: not loaded from GitHub yet, GitHub could not be read, the pull request is not in the fetched data, or no result link was recorded. A finished step with a missing or unrecognised result link is unknown, never settled.
  - **Runs, cost and the provider chain** are folded into a details row.
  - **Since you last looked** comes first. It covers steps merged, steps delivered, steps newly waiting for the owner, and agent runs that failed or were rejected by the independent checker.
    - The supervisor's own step errors and liveness problems are a separate line for whoever maintains AIWorks. They are never counted as agent runs; a failing supervisor step is recorded on every check.
    - The window starts at the viewer's last visit, kept in that browser's `localStorage` (a per-viewer convenience).
    - A first visit, or a browser that blocks storage, shows the last 24 hours.
    - The server counts from the journal through `/api/state?since=`, bounded to 30 days.
  - **Needs you, per pull request.** Each pull request item says:
    - whether it is ready to merge. *Ready to merge* needs GitHub data under 5 minutes old, from a successful fetch (not the startup cache) by a refresh that is not failing, showing:
      - the pull request's head is still the commit the independent checker accepted;
      - it is not a draft;
      - GitHub reports no conflicts;
      - at least one CI check ran and every one passed.
      
      Otherwise the item names the accepted commit and what is not confirmed: a different head, conflicts, a conflict check still running, failed or unfinished checks, or no CI checks. Without that data it says *check conflicts and CI on GitHub before merging*.
    - what to check first (many tries or rejections);
    - what merging unlocks or, when nothing else waits on it, the project's release rule. Only steps that have not started yet are named, as *cannot start until you merge it* or *Merging lets X build on it*. A step starts from the base branch as it is at its first run and keeps that base, so a dependent that has already started is named as *already started without it, so merging now does not change that step*.
  - **Supervisor not checking in.** If an agent is still working, the item says so and names the host, the last check-in time and the concrete restart action. For the first 5 minutes after the controller lease lapses, the campaign shows *Supervisor checking in late* and no restart advice, because a restart or an upgrade is usually in progress.
    - A campaign that no supervisor has picked up yet gets the same 5 minutes from its registration. During that time it shows *Waiting for the supervisor* and no restart advice. After that, Needs you says *The supervisor on &lt;host&gt; has not started &lt;campaign&gt; yet* with the restart action.
  - **Reports.** A posted report says *For you to read and decide on*. It is for the owner to read, not "nothing to do".
  - **Finished campaigns.** The banner says *nothing waits for you* only when every step's GitHub state is known and settled. Otherwise it says plainly what is open:
    - GitHub state not loaded yet, GitHub could not be read, a pull request not found or a missing result link;
    - pull requests closed without merging;
    - steps waiting for review;
    - reports to read. A campaign of reports only shows the supervisor's own next action (review the recommendations before assigning implementation), or *N reports posted for you to read*;
    - merged work that is ready, with the project's release rule.
  - **Agent verdicts.** Each agent shows *Working normally*, *Possibly stuck (no progress for N min)*, *Starting* or *Not started*, from its own session record. The rule is explained once on the page.
  - **Cost so far** totals the reported cost across campaigns with a cost per delivered step. A run without a reported cost, including one still in progress, is *not reported*, never $0.00.
  - **At 520px or narrower:**
    - step tables become stacked rows;
    - the progress line shortens;
    - navigation becomes a labeled bottom bar.
  - **Dates** are English (`10 Oct 12:23`) whatever the computer's locale.
  - **Navigation.** Choosing a view opens it at its top. Back and Forward return to where that view was left ([UX-001](https://github.com/netbka/engineering-platform/blob/main/policies/UX-001.json) preserve-context).
  - **Large screens.** From 1900px wide the whole page is scaled by 1.12. From 2300px it is scaled by 1.25 and the column is wider, so text is not 10–12px on a 2560px screen.
  - **Background.** The page is light only, and its background is explicit, so a dark system preference never shows through.
  - **Supervisor faults** say they are not an owner action and link the supervisor issue ([netbka/aiworks#2](https://github.com/netbka/aiworks/issues/2)). The "since you last looked" line also links to Activity, which shows when they happened.
- Roadmap: registered project campaign plans and their results, followed by the Engineering Platform roadmap from the governance checkout: all 8 product phases, 7 post-MVP increments and 23 governance rollout packages, plus tracked platform extensions and review packages. Search and track/status filters apply to the platform packages. A campaign plan is its authorized scope, not the target repository's entire backlog.
- Issues & PRs: all fetched Engineering Platform work, all issue/PR metadata for repositories configured in the selected supervisor data directory, and governance-linked work in the referenced portfolio repositories; open, closed and merged states stay distinct.
- Agents & tasks: running implementer/verifier operations; for active campaigns only, configured provider priority, waiting reasons and retry times, worker slot limit, role restrictions, queue/dependencies, outcomes and result links. A heartbeat proves the runner is alive, not that the task is progressing. Last output time is file metadata only; providers emitting only a terminal receipt may have no output until completion.
- Activity: worker starts/outcomes, provider switches with their reason, verified publications and owner commands. Duplicate dashboard processing and lease-renewal bookkeeping are omitted.

The sidebar and footer name the computer and the dashboard revision. Until the first answer arrives, the sidebar shows a neutral "…" rather than a guess. Each computer runs its own supervisor, campaigns and dashboard, so a screenshot shows which one it came from. A provider that cannot run on this computer at all (Cursor's native sandbox on Windows) shows as *Not available on this machine*, not as eligible for retry.

The dashboard always fetches GitHub metadata for every campaign's target repository, in addition to the roadmap repositories. That is how finished steps are matched to their pull requests.

Merge readiness of open pull requests is a separate read-only `gh pr list --state open --json number,headRefOid,mergeable,statusCheckRollup`. Only the head commit, GitHub's conflict state and the check counts (passed, failed, not passed yet) are kept; check names and links are not. If that call fails, readiness is unknown and the repository's other metadata is unaffected.

Provider credit/rate failures come from execution receipts. Account balances are not queried, and unknown balances are never displayed as zero. Fallback retains the authorized cap and never overrides a permission denial. “Not running” means no operation currently uses that provider; it is not proof of native readiness. A campaign allows one worker slot, so three configured providers do not mean three simultaneous agents. Attempts include recorded refused attempts, while counted runs apply the explicit zero-work refund rule.

Definitions come from Engineering Platform's `docs/PRODUCT_ROADMAP.md`, the PR program in its `docs/AUTONOMOUS_ROLLOUT.md`, and its agent-role catalog `registry/agents.json`, all read from the governance checkout. GitHub owns work state. The display does not infer that an open issue, an assignee or a planned role is a running process. A merged implementation with an open tracking issue remains in progress/review and explicitly reports that code has merged. Closed tracked issues mean *recorded complete*, not proof of deployment or an independent re-verification. GOV-01 has an explicit link to Engineering Platform's original baseline adoption PR #1.

Supervisor state is read from its existing SQLite store with a read-only connection; GET requests never bootstrap a missing store. Runtime refresh is every 5 seconds. GitHub metadata refresh is every minute, with a bounded 1,000 issues and 1,000 PRs per referenced repository. Reaching that limit is displayed as partial history. A failed refresh keeps the last successful metadata and marks the source stale; missing evidence stays unknown. The cache contains metadata, not another task-state authority. At startup the cache is served only for configured repositories: the roadmap repositories, those in the supervisor data directory's `config.json`, and a campaign target repository once it is tracked. Until a fetch of that repository succeeds, its cached data is marked as a startup cache and is never treated as fresh.

## Commands

Controls apply to existing **supervisor-managed campaigns**. Other chat/IDE agents have no command transport attached to this dashboard.

| Command | Effect |
| --- | --- |
| Pause | Stops new dispatch; an existing worker can finish. |
| Resume | Resumes the recorded declaration with its existing authorization and run cap. |
| Recheck | Queues the existing recovery event, for a campaign or a selected unfinished task. It does not force acceptance or bypass owner-reserved conditions. |
| Cancel | Requires a confirmation explaining that the controller terminates its owned workers and that cancelled campaigns cannot resume. Completed results remain available. |
| Send instructions | Select an unfinished task and implementer/verifier role. Up to 2,000 characters are queued for that role's next run on the task; an already running worker is not interrupted. |

Acknowledgement means the command was recorded. A queued recheck/cancel still needs a live controller to act. No command changes authorization, budget, provider order, project scope or declarations; arbitrary shell commands are not executed. No new campaign can be registered through this surface.

Free-text guidance is supplemental to the immutable task packet and never changes its permissions, acceptance criteria or independent review requirement. Credential-like text and control characters are rejected. There can be five pending instructions per task. Delivery is committed atomically with an admitted operation and recorded in its immutable prompt; a preflight failure leaves instructions queued. Receipts distinguish queued, attached to a specific run, outdated authorization, and no future run. "Attached" does not claim the model has read or followed it, or that the run succeeded. If that run fails, the owner can inspect its outcome and send guidance again. Older controllers cannot deliver instructions; upgrade the controller to this change before using this command. Drafts survive polling and are cleared only after an accepted receipt.

Commands use the existing supervisor APIs within one transaction. The request is bound to campaign row version, authorization version, scope digest and, for task recheck, task version. Changed state returns a conflict. A durable request ID is bound to the exact payload; repeating it acknowledges the original command without applying it twice. Commands and receipts use the existing events/journal tables.

## Local access boundary

The server binds only to `127.0.0.1`; the local host is the trust boundary. This is not a remote or multi-user authentication service. Do not expose it through a proxy, tunnel or public interface without a separately reviewed authentication layer.

Requests require the exact loopback Host.

**Links from other apps.** Following a dashboard link from another site (GitHub, Telegram, email) is a top-level `GET /` with `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` and no `Origin`, and it returns only the static page. All other cross-site requests are still refused, including:
- `/api/*`, including the CSRF session;
- scripts and styles;
- framing;
- every POST.

The page then loads its data with same-origin requests.

Commands are JSON POSTs with exact same Origin and a per-process CSRF token; foreign/null/missing command origins are rejected. Responses prohibit framing and cross-origin reads. They also set `Cross-Origin-Opener-Policy: same-origin`, so a dashboard page opened from another site shares no window reference with that site. All remote labels/titles render as text and links are constrained to GitHub. Snapshot fields are allowlisted: raw worker output, prompt packets, session identities, local workspace paths, secrets and raw error text are not served. Heartbeat reads are confined to the configured runs directory.

## Verification

Completed/cancelled campaigns do not appear as controller failures when their historical leases expire. Their task rows distinguish verified PR/report publication from repository or product completion. They expose provider, dependency-integration and blocker waits with retry times. Execution snapshots are read live every five seconds. GitHub metadata refreshes every minute, and the connection label identifies stale/unavailable GitHub evidence rather than treating a successful local connection as a fresh remote observation.

`tests/dashboard/dashboard.test.mjs` exercises roadmap coverage/evidence, the startup cache limited to configured and tracked repositories, read-only snapshots, safe metadata, real API transitions, stale/ABA protection, authority preservation, duplicate delivery and HTTP request protections and response headers using disposable data.

`tests/dashboard/owner.test.mjs` exercises:
- the owner view: review items, the steps they unblock, churn notes, unknown GitHub state, closed pull requests, decisions and an unreadable coordinator inbox;
- the page order: campaigns with something for the owner and active ones first, finished ones collapsed to one line each, newest first;
- `purpose`/`outcome` validation and the unchanged scope digest;
- the host label;
- cross-site link navigation, with `/api/*` still refused.

`tests/dashboard/claims.test.mjs` checks that owner-facing statements claim no more than the state supports:
- a posted report is for the owner to read, and a finished reports campaign shows the supervisor's next action;
- a finished campaign is calm only when every step's GitHub state is known and settled, including before the first fetch and when `gh` fails with no cache;
- a missing or unrecognised result link is unknown. It, and a pull request missing from fetched data, become a *Check on GitHub* item; only state a refresh can still bring keeps *Checking GitHub…*;
- *Ready to merge* needs fresh GitHub data showing the accepted commit, no conflicts and passing CI;
- the readiness fetch is read-only, keeps counts only and fails without affecting other metadata;
- restart advice waits for the grace period after the lease lapses, or after registration for a campaign no supervisor has picked up;
- *Merging lets X build on it* names only steps that have not started;
- the calm heading covers only blocking items, and reports to read and merged work ready for release are named apart;
- Needs-you items built from a startup cache, old data or a failing refresh say when the data is from, and are never *Ready to merge*;
- a pause by itself is a neutral campaign state, never a Needs-you item, but a paused campaign whose supervisor stopped or never started is listed with the restart action;
- each Needs-you item leads with what its step delivers, with the evidence in one line;
- release wording follows the registry: a recorded standing deploy authorization, else the project's own release policy, and never "your release".

`tests/dashboard/presentation.test.mjs` checks the presentation follow-ups from the live reviews ([netbka/aiworks#4](https://github.com/netbka/aiworks/issues/4)):
- campaign titles from declared wording, and humanized distinguishing names;
- views that open at their top, with Back restoring the position;
- provider detail for active campaigns only;
- the neutral host placeholder;
- the explicit page background and large-screen scaling;
- supervisor-fault wording that links where faults are tracked.

No verification command pauses or cancels a live campaign.

Run the focused suite with `node --test tests/dashboard/dashboard.test.mjs`, then the repository gate with `npm run check`.
