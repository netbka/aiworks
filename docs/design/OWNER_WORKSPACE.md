# Owner workspace: one question per screen

**Privacy boundary:** this is a design proposal, not a live installation record. Campaign declarations and approval records stay private under [AW-009](../DECISIONS.md#aw-009---public-commits-contain-no-installation-data). Any proposal to publish declarations through source branches or pull requests is superseded. Merged executable code, explicit owner authorization, scope binding and independent verification remain required.

**Status:** design only. Nothing in this document is built or deployed. It is the design for #11, part of the program in [PROJECT_WORKSPACE_PLAN.md §4](../PROJECT_WORKSPACE_PLAN.md#4-owner-information-architecture---one-primary-question-per-screen) (#14). It builds on the owner view from #4 and the review items carried over in #6.

**Basis.** The code at `<revision>`. Statements about today's dashboard are **observed**: read from the code at that revision, with `file:line`. None of them was checked on the live workstation dashboard, so none is **verified**. Everything else here is **planned**. Where we do not know something, it says **unknown**. A merged change is not a deployed one ([AGENTS.md, evidence rule](../../AGENTS.md#evidence-and-secrets)).

**What this document settles.** The screens, what each one asks and shows, the exact English copy for each state, the order of work and the review method. Questions only the owner can answer are listed in [§12](#12-owner-reserved-questions). It does not reopen D1, D3, D5 or D9 ([plan §8](../PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates)). It keeps AW-001 to AW-007 as written ([DECISIONS.md](../DECISIONS.md)).

Refs #11, #4, #6, #14.

---

## 1. What changes for the owner

Today the dashboard opens on one long page about every campaign on this computer. Its navigation names machine parts: Overview, Plans, Issues & PRs, Agents, Messages and Activity (observed: `src/dashboard/public/index.html:16-23`).

After this work the owner opens AIWorks and sees **their projects**. They pick one, see where it stands in one sentence, and act only when something needs them. Everything the machine records is still there, one click further down.

Three rules hold on every screen:

1. **One question.** Each screen answers one question, written at the top of this design for that screen.
2. **At most one primary action.** One button stands out, or none does. Disabled buttons are not shown as decoration.
3. **The truth, in plain words.** A published pull request is never called merged, deployed, done or accepted. Unknown is never shown as nothing, zero or green.

The UI is English only (D9).

---

## 2. Words

### 2.1 Words the owner sees

| Owner word | Meaning | Machine word (details only) |
| --- | --- | --- |
| Project | A folder on this computer that AIWorks works on, with or without GitHub (D1). | target repository, project registry entry |
| Work | One piece of work the owner asked for and approved, with its goal. | campaign |
| Step | One part of that work with its own result. | task |
| Builder | The AI worker that makes a step's change. | implementer |
| Independent checker | A separate AI worker that checks the result. | verifier |
| AI worker | Claude, Codex or Cursor running on this computer. The one word for them: never "agent" (aiworks#11 review 4 F17). | executor, provider, agent |
| Plan | What AIWorks proposes to do, before the owner approves it. | declaration, task graph |
| Approve | The owner's one approval of the goal and limits of a piece of work (D3). | authorization, registration |
| Result | What a step produced: a pull request, a report, or (later) a checked local change. | deliverable, `pr_url` |
| AIWorks | The program on this computer that plans, runs and checks the work and reads the owner's messages. | supervisor, controller, coordinator, coordinator agent |
| Your project rules | The list of projects AIWorks may work on and the rules each follows. They are kept outside AIWorks, in the governance platform's checkout on this computer. | governance provider (the platform's placeholder name), governance root, rules folder, registry |

### 2.2 Words never used at the primary level

These appear only inside "Details" disclosures and Settings › Diagnostics: pipeline, fencing, lease, slots, control plane, campaign declaration, scope digest, authorization version, operation, executor, DAG, run ID, packet, B2/B3/B4, heartbeat, supervisor, coordinator, agent, governance provider, rules folder. One name is kept because it is a name, not a word for a concept: the product "Cursor Agent". How AIWorks runs on the computer is not named either: no scheduled task and no task name. Restart advice says what the owner does (sign out and in, or restart the computer) and who to turn to when that does not help (aiworks#11 review 5 G4). On Work, Cost, Now and Start work, Details use an owner word where one exists: "AI worker", never "provider"; "work", never "campaign". The state chip on a Work card says "AIWorks running" or "AIWorks running · work paused", never "Supervisor" or "campaign". One name per action: "Check again", never "Recheck". The Work page's footer reads "AIWorks does not read your AI workers’ account balances: a limit means an AI worker said it hit one, not a measured balance. Switching to the next AI worker never overrides a permission denial…" (aiworks#11 review 5 G13). No test pins these words: under the test rule in AGENTS.md (owner decision 2026-10-17) wording is checked by the owner review, not by a test (aiworks#11 review 4 F4).


### 2.3 Words for result states

The same word always means the same thing:

| State word | Used only when | Never used for |
| --- | --- | --- |
| Being built | a builder is running on the step | |
| Being checked | an independent checker is running on the step | |
| Passed the check | the independent checker accepted the step's commit | "accepted" (kept for the last row) |
| Pull request open · waiting for your review | GitHub reports the step's pull request open | "done", "delivered" |
| Merged | GitHub reports it merged | "released", "deployed", "live" |
| Closed without merging | GitHub reports it closed and not merged | |
| Report posted · for you to read | the result is an issue comment | "nothing to do" |
| Not known yet | GitHub state not loaded, unreadable or not found | "nothing", "0" |
| Released | only with recorded release evidence (#13); not built | |
| Accepted | only with recorded acceptance evidence (#4 remaining item); not built | |

Today's code already keeps merged, waiting for review, closed, report posted and unknown apart (observed: `src/dashboard/owner.mjs:59-75`, `src/dashboard/owner.mjs:50-52`). Today's checker sentence says "Checker accepted the head" (observed: `src/dashboard/owner.mjs:95`). The design renames it to "Passed the check" so "accepted" is free for the acceptance state.

---

## 3. Navigation

### 3.1 Map

```
Projects                      (global)  Which project should I open?
Needs me                      (global)  What is waiting for me, across projects?
Settings                      (global)  What can AIWorks use on this computer?
  ├─ This computer · AI workers · Projects · Release mode
  ├─ Messages                           What did I ask AIWorks, and what did it answer?
  └─ Diagnostics                        What exactly did the machine record?

Project ▸ <name>
  ├─ Now            (tab)               Where are we now?
  ├─ Work           (tab)               What is running or waiting, and why?
  │    └─ Step      (from a row)        What is happening on this step?
  ├─ Results        (tab)               What has been delivered, and what remains?
  ├─ Cost           (tab)               What did this cost?
  ├─ Start work     (from a button)     What should AIWorks do?
  │    └─ Review    (after Start work)  Is this the right goal and limits?
  └─ Add project    (from Projects)     Which folder should AIWorks work on?
```

Start work, Review, Step and Add project are reached by an action, not a tab. That keeps the project bar to four tabs, which fit at 320px.

### 3.2 Addresses

Each screen has its own address, so Back, Forward, reload and bookmarks work. They are hash routes, so the server's file list stays as it is apart from new script files (observed: static files are an allowlist, `src/dashboard/server.mjs:10-14`).

| Screen | Address |
| --- | --- |
| Projects | `#/projects` (also the address for an empty hash) |
| Needs me | `#/needs` |
| Settings | `#/settings`, `#/settings/messages`, `#/settings/diagnostics` |
| Now | `#/p/<project>` |
| Work | `#/p/<project>/work` |
| Step | `#/p/<project>/step/<work>/<step>` |
| Results | `#/p/<project>/results` |
| Cost | `#/p/<project>/cost` |
| Start work | `#/p/<project>/start` |
| Review | `#/p/<project>/review/<plan>` |
| Add project | `#/projects/add` |

`<project>` is the GitHub `owner/repo`, URL-encoded, for a GitHub project. For a local project it is the opaque ID that project connection (#7) assigns. Never a filesystem path.

Today's addresses `#overview`, `#roadmap`, `#work`, `#agents`, `#messages` and `#activity` (observed: `src/dashboard/public/dashboard.js:71-72`) are redirected once, with `history.replaceState`, as in [§9](#9-what-todays-views-become).

### 3.3 What is kept across moves

- **Route.** The address is the state. Reload opens the same screen.
- **Selected project.** Projects offers one project first as "Continue with <name>": the one where the owner left unfinished work. A project with an unsent draft (a Start work goal or a step instruction, below) comes first, and the line adds "Your unsent draft is kept there." When the last opened project has a draft too, it stays first; otherwise the project whose draft was kept first. Without a draft it is the last opened project, remembered in `localStorage`. This is the same per-browser convenience as today's "since you last looked" (observed: `src/dashboard/public/dashboard.js:27-28`). The last opened project alone sent the owner away from a half-written plan request (aiworks#11 review 4 F19).
- **Screen per project.** Opening a project from outside it (from Projects, "Continue with <name>", Needs me or another project) opens the screen that project was left on, for example its Start work half-way through a plan request. The project's Now tab still opens Now. This holds while the page stays open in that tab. It is what [§13.3](#133-tasks) T10 and the [#11](https://github.com/example-org/aiworks/issues/11) acceptance ask for: switching projects "without losing route, draft, scroll".
- **Scroll.** Every address returns to where it was left, whether the owner reaches it by a link, Back or Forward. An address not opened yet in this tab opens at its top. The page keeps this per address while it stays open in that tab.
- **Unsent drafts.** The Start work goal, step guidance and the message to AIWorks are kept in `sessionStorage`, per address. They survive the 5-second refresh, a reload, Back and a move to another project and back. They are cleared only after the server returns an accepted receipt. Today drafts live in memory only and are lost on reload (observed: `src/dashboard/public/dashboard.js:32`, `src/dashboard/public/dashboard.js:435`).
- **Open details.** An opened "Details" disclosure stays open across refresh. Today's disclosures already do (observed: `src/dashboard/public/dashboard.js:224`).
- **Identity.** A step is always shown with its project and its work's goal, so moving between projects never mixes them up.

### 3.4 Global frame

- **Header.** The AIWorks mark (a link to Projects), the computer's name, a connection line and a "Messages" link. The computer's name stays because each computer runs its own AIWorks (AW-006; observed: `src/dashboard/public/dashboard.js:653-658`).
- **Needs me count.** The "Needs me" item of the navigation carries the count of owner actions. While a merge check runs it is partial, never final: "7 + checking", or "checking" with nothing confirmed yet. It shows the final count once the check ends ([§1](#1-what-changes-for-the-owner) rule 3; aiworks#11 review 4 F3).
- **Connection line.** It says **Page connected**, or the disconnected text. It is about this page's link to the dashboard, never about AIWorks' work. A bare "Connected" read as "AIWorks is running" while Needs me said AIWorks had stopped (aiworks#11 review 4 F6). Whether AIWorks runs is said on the screens, from [§7.2](#72-disconnected).
- **"Refresh GitHub"** moves from the header to Settings › Diagnostics. GitHub refreshes by itself every minute (observed: `src/dashboard/main.mjs:39`). Stale data is said on the screens that use it ([§7.4](#74-github-stale)).
- **"Message coordinator"** becomes the "Messages" link. Sending a message is the primary action of Settings › Messages, not a header button on every screen.

---

## 4. Screens

Each screen lists: its question, what is visible first, its one primary action, and what stays in details. "Primary action" is the single prominent button. Row links and the "More" menu are secondary.

### 4.1 Projects

- **Question.** Which project should I open?
- **First visible.** "Continue with <last project>" when there is one. Then one row per project:
  - its short name (the repository name, or the folder name for a local project);
  - its kind: "GitHub", "Local Git" or "Folder";
  - **one** state in plain words, from [§7](#7-state-copy). A connected project where work cannot start reads "Can't start work yet", in a neutral tone, beside its sentence; it is never a green "Ready" (aiworks#11 review 5 G9). Settings › Projects shows the same word. With nothing for the owner it is the sentence the project's Now screen leads with ([§4.4](#44-now-inside-a-project)), so the two agree, also right after Pause and Resume. With more than one piece of active work it starts with the purpose of the work it is about: "Let customers save a wishlist · Possibly stuck: Wishlist page has made no progress for 25 minutes." (aiworks#11 review 4 F10, F14). What else Now keeps in view ([§4.4](#44-now-inside-a-project)) follows in short, whatever leads, Needs me items included: "One thing needs you. Also: 1 AI worker possibly stuck · 1 piece of work paused, with Resume on Now · 1 AI worker working." So a possibly stuck worker or a pause never hides behind the count of Needs me items (aiworks#11 review 5 G5);
  - **one** next action as a link, for example "Review pull request #465" or "See results".
  
  While a merge check runs, a project's state is partial, never final: "2 things need you so far. Checking GitHub… The state of 3 results is not known yet.", or with nothing listed for the owner the state "Checking" with the same sentence, after the Now sentence when work is active. It never reads "Running" or "Finished" alone then ([§1](#1-what-changes-for-the-owner) rule 3, [§7.4](#74-github-stale); aiworks#11 review 4 F3).

  Projects that need the owner or are being checked come first, then those with work running, then the rest by last activity.
- **Primary action.** "Add project". It appears only once project connection exists (slice S11). Before that, the screen has no primary button, and the empty state says how projects appear today ([§7.1](#71-empty)).
- **In details.** Repository owner, base branch, connection check time, the number of pieces of work.

Today there is no project object. Campaigns carry their target repository (observed: `src/dashboard/supervisor.mjs:172`), and `config.json` lists the repositories this computer may work on (observed: `src/dashboard/roadmap.mjs:24-29`, `README.md:86`). Slice S2 builds the project list from those two. Local Git and plain folders need #7.

### 4.2 Needs me

- **Question.** What is waiting for me, across all projects?
- **First visible.** A heading with the count, then one group per project, then a group called "AIWorks itself". When "AIWorks itself" holds an item that holds up work in several projects (AIWorks stopped on this computer), that group comes first, with that item at its top: no project item it holds up can move until it is fixed (aiworks#11 review 4 F5). Each row is one decision, worded as today's items: what to do first, then what the step delivers, then one link to act. Examples:
  - "Review and merge · Telegram ingestion: analysed messages are not sent again · Open PR #465";
  - "Decision needed · <step outcome> · Open the step";
  - "Closed without merging · <step outcome> · Open PR #463".
  
  The evidence is one short line under the row, for example "Passed the check at this commit · no conflicts · no CI checks ran".
- **Primary action.** None at screen level. Each row has exactly one action link.
- **In details.** The full evidence sentence, what merging unlocks, the "took N tries" note, GitHub data age.
- **Not here.** Waiting for an AI worker's usage limit to reset is not an owner task (AW-002). A pause by itself is not an owner task (observed: `src/dashboard/owner.mjs:268-271`).
- **Not here: project setup.** A setup problem met in Add project (no project rules, no Git, a configuration file that disagrees) is said on Add project, where it happens, and a connected project that needs setup says so on Projects and its Now screen. Needs me lists work only, so its calm line speaks of work only: "No work is blocked on you right now" ([§7.1](#71-empty)). It never says "nothing is blocked" while setup may be (aiworks#11 review F8).
- **Named, not counted: a project held up by the owner's decision.** A connected project without GitHub whose rules the owner has not confirmed ([§5.3](#53-adding-a-plain-folder-after-s11)) is no Needs me item: no work is blocked there, so no count includes it. But Needs me is where the owner looks for their decisions, so it is never an all-clear while such a project waits. The calm headline names it: "No work is blocked on you right now, but Recipes waits for you to confirm their rules before work can start" (with several, "but 2 projects wait…"). One row per such project follows: "Recipes · Can't start work until you confirm this project's rules. You confirm them on its Now screen. Open Recipes". The owner read the bare calm line as wrong while their own decision held the only project (aiworks#11 review 5 G7, review 4 F8). Built with slice UI17.

The items are today's "Needs you" items, unchanged in meaning (observed: built in `src/dashboard/owner.mjs:228-294`, counted in `src/dashboard/owner.mjs:297`). The "AIWorks itself" group holds the supervisor and coordinator items, which today already say they are not owner actions (observed: `src/dashboard/owner.mjs:273-275`, `src/dashboard/owner.mjs:292-293`). They stay listed because nothing else will report them. The group is shown after the project groups, except when it holds up work in several projects: then it leads, as above. At 320 px the root problem was otherwise found only after about 2,300 px of project items it made pointless (aiworks#11 review 4 F5).

### 4.3 Settings

- **Question.** What can AIWorks use on this computer?
- **First visible.** Four short sections:
  - **This computer:** name and dashboard version (observed: `src/dashboard/server.mjs:26`).
  - **AI workers:** one line per AI worker, **once per computer**, for example "Claude · ready", "Codex · not set up on this computer", "Cursor · not available on Windows". Today the same three boxes repeat on every campaign (observed: `src/dashboard/supervisor.mjs:194-210`; reported in #4).
  - **Projects:** each project's kind and connection state.
  - **Release mode,** per project: "Review only" (on) and "Auto Release" (off, unavailable). See [§10.3](#103-release-mode). It lists every project Settings › Projects lists.
- **Primary action.** None today. Settings only shows what the machine has.
- **In details.** Provider order per piece of work, retry times, role limits, the AIWorks version of each running supervisor.

#### Settings › Messages

- **Question.** What did I ask AIWorks, and what did it answer?
- **First visible.** The message box, then past messages with their receipts: Received, Read and Answered (observed: receipts in `src/dashboard/supervisor.mjs:257-266`).
- **Primary action.** "Send".
- **In details.** The read agent's turn and tool counts.

#### Settings › Diagnostics

- **Question.** What exactly did the machine record?
- **First visible.** The full activity journal, Issues & pull requests, and the governance provider roadmap, each behind its own heading. "What connected projects wait for" lists each connected project where work cannot start, with its code and the decisions and issues it waits for (aiworks#11 review 5 G3).
- **Primary action.** None. "Refresh GitHub" is a secondary button here.
- **In details.** Everything else. This is where technical words are allowed.

### 4.4 Now (inside a project)

- **Question.** Where are we now?
- **First visible.**
  1. The project's goal: the purpose of its active work, else its latest finished work. Purpose comes from the declaration, then a one-step work's outcome, then the tracking issue title (observed: `src/dashboard/owner.mjs:147-155`).
  2. **One sentence** for where it stands, from [§7](#7-state-copy). What needs the owner leads it.
  3. **Also in this project:** whatever the sentence leads with, every worker possibly stuck, every pause the owner can resume, with its own "Resume" button, and every worker at work, one line each, in that order. A line the sentence already says is not repeated. Work AIWorks is not checking on has its own item and is not listed here. With several pieces of active work each line starts with the work's purpose. Now answers "Where are we now?" for the whole project, not only "Is anything waiting on me?" (aiworks#11 review 5 G5, review 4 F14).
  4. Progress in the owner's terms, for the whole project, counted as Results counts it: "6 of 9 steps have results · 3 merged · 2 waiting for your review". With more than one piece of work it says what it counts: "All work in this project: 6 of 9 steps have results · …". It never counts only the piece of work the sentence is about, so Now and Results give one number (aiworks#11 review 5 G11).
  5. "Since you last looked", only for this project (observed today across all projects: `src/dashboard/owner.mjs:325-340`).
- **Primary action,** by state (one at a time). The Resume of a pause listed under "Also in this project" is a secondary button on its own line:

  | State | Primary action | Goes to |
  | --- | --- | --- |
  | No work yet | Start work | Start work |
  | One thing needs you | that item's action, for example "Review pull request #465" | GitHub, or Step |
  | Several things need you | "See the 3 things that need you" | Needs me, this project's group |
  | Running or waiting | Open current work | Work |
  | Paused | Resume | stays here |
  | Blocked | See what's needed | Step |
  | Finished | See results | Results |
  | AIWorks stopped, or page disconnected | none | |

- **In details.** Other pieces of work in this project, the tracking issue, the work's name as the CLI knows it: "Known to AIWorks as shop-contracts", and "Show product reviews (known to AIWorks as shop-reviews)" for the others, never "Campaign shop-contracts" (aiworks#11 review 5 G13).

### 4.5 Start work

- **Question.** What should AIWorks do?
- **First visible.**
  - A text box: "What should be true when this is finished?"
  - "Start from" choices: "Just my description", "A GitHub issue", "A GitHub pull request", "A plan file in the project". GitHub choices appear only for a GitHub project.
  - Two modes: **Plan only**: "AIWorks looks and proposes a plan. Nothing in your project changes." **Plan and do**: "AIWorks proposes a plan. After you approve it once, it does the work."
- **Primary action.** "Ask for a plan".
- **In details.** Which AI workers may be used, optional spending limit, how results are published.

**Today and after.** Plan only uses the existing message path: the dashboard sends the coordinator the selected project, goal and chosen issue or pull request. The coordinator is read-only; its checked final reply stays in the local dashboard and creates no GitHub issue, PR or comment (AW-004, amended 2026-10-13). "Plan and do" is shown but not selectable until slice S10 ([§11](#11-implementation-slices)). Its line reads: "Starting work from this page is not built yet. Today, work starts when an authorized private plan is registered on this computer." Projects without GitHub still need the local intake contract in S12; storing replies locally alone does not enable their planning.

### 4.6 Review

- **Question.** Is this the right goal and limits?
- **First visible.** In this order ([plan §3.2](../PROJECT_WORKSPACE_PLAN.md#32-work-request---one-authorization-autonomous-execution-inside-its-scope-owner-approved-d3)):
  1. the goal and how success is checked;
  2. the main steps, in order, each with its result;
  3. earlier or overlapping work found in this project;
  4. what may change: the project, which files or areas, which AI workers, any spending limit, and "Release: Review only";
  5. a note: "After you approve, AIWorks plans, splits, retries and checks the steps by itself. It asks you again only to change the goal, the limits or the release mode." (D3)
- **Primary action.** "Approve and start". A secondary link: "Change the request".
- **In details.** The full step graph, per-step instructions, the plan as JSON.

The Review screen waits for a supervisor admission API (#8) and for [owner question Q1](#12-owner-reserved-questions). Until then the screen is not reachable, and "Plan and do" says why ([§4.5](#45-start-work)).

### 4.7 Work

- **Question.** What is running or waiting, and why?
- **First visible.** The steps of the active work, in the order they can run. Each row has:
  - the step's outcome (its title is secondary);
  - one state from [§2.3](#23-words-for-result-states);
  - why it waits, in plain words, for example "Starts after 'Contracts import' is merged" or "Waiting for an AI worker to be free · next try 14:05".
  
  Running steps show who is working: "Builder (Claude) · working normally · last activity 2 min ago".
- **Primary action.** "Resume" when the work is paused. Otherwise none.
- **More menu** (secondary): Pause, Check again, Cancel work. Cancel keeps today's confirmation (observed: `src/dashboard/public/index.html:42`). The menu is not shown for finished or cancelled work (observed today: no controls on finished cards, `src/dashboard/public/dashboard.js:316-318`).
- **In details.** Dependencies as a list, attempt counts, the AI worker order ("AI workers in order of preference"), "Runs, cost and AI workers", the run limit ("this work has no run limit") and "Check again asks AIWorks to look again; it never skips the independent check."

Today these facts sit on campaign cards and the Agents page (observed: `src/dashboard/public/dashboard.js:314-352`, `src/dashboard/public/dashboard.js:155-178`). Wait reasons are already turned into sentences (observed: `src/dashboard/supervisor.mjs:20-28`), but some keep machine words, such as "Waiting for verified dependencies in main: P3, P4" (observed: `src/dashboard/supervisor.mjs:23`). Slice S5 rewrites them with step outcomes instead of IDs.

### 4.8 Step

- **Question.** What is happening on this step?
- **First visible.**
  1. The outcome, the work's goal and the project.
  2. One state, and who is on it: "Being checked by an independent checker (Claude) · working normally".
  3. Progress from the worker's own record: turns, tool calls, last activity (observed: `src/dashboard/supervisor.mjs:76-106`).
  4. The last result: "Passed the check at commit fedf9cf" or "The checker found 2 blocking problems; the builder is fixing them". A last result of "invalid result" says beside it what kind of failure that is and, when the step has stopped, what fixing the cause involves ([§7.7](#77-blocked)). The words come from the result's kind and role only, never from the worker's text (aiworks#11 review 4 F13).
  5. Guidance you sent, with its receipt: Queued, Read by the next run, or Not delivered (observed: `src/dashboard/supervisor.mjs:211-223`).
- **Primary action,** by state: "Send guidance" while the step is unfinished; "Open pull request #N" once it has one; "Open the step issue" when it is blocked on a decision.
- **In details.** Every attempt with its end (from the journal), the exact model, limits, run IDs.

Today the step's attempt history is only in the global journal of the last 80 events (observed: `src/dashboard/supervisor.mjs:244`). Slice S5 adds a read-only per-step query in `src/dashboard/supervisor.mjs`; no supervisor change.

### 4.9 Results

- **Question.** What has been delivered, and what remains?
- **First visible.** Results grouped by state, in this order:
  1. Waiting for your review;
  2. Closed without merging;
  3. Reports to read;
  4. Merged;
  5. Not known yet.
  
  Each row shows the step outcome and the state word from [§2.3](#23-words-for-result-states). A merged row adds the project's release rule: "Merged 10 Oct. Release follows sampleapp's standing deploy authorization." (observed: `src/dashboard/owner.mjs:107-108`). It never says released or live.
- **Primary action.** "Review pull request #N" for the oldest waiting review. Otherwise none.
- **In details.** The full check evidence, the commit, CI counts, data age.
- **Local projects (built, UI17).** A checked local revision reads "Ready for your review" with **Apply**: nothing in your folder changes until the owner presses it. Applied, it reads "Applied to your folder" with **Undo apply**. No pull request is ever shown for a project without GitHub (plan §1).

### 4.10 Cost

- **Question.** What did this cost?
- **First visible.** The finished work's cost, kept apart from work not finished yet, so the first number answers "What did the finished work cost?" (aiworks#11 review 5 G12): "$254.22 reported for finished work · about $10.17 per step with a result", then "6 runs of the finished work did not report a cost, so its real total is higher.", then "Work not finished yet, counted apart: $12.40 reported so far." and "3 runs still running; their cost is not known yet." Cancelled work that ran counts as ended and is named: "finished or cancelled work". With no finished work that ran, the headline says so: "$12.40 reported so far · this project's work is not finished yet", or "No cost reported for this project yet". Unknown is never $0.00 (observed today across all campaigns: `src/dashboard/public/dashboard.js:100-102`, `src/dashboard/public/dashboard.js:112-113`).
- **Primary action.** None. "See the breakdown" opens the details.
- **In details.** Per piece of work and per step: runs, reported cost, unreported runs, retries and checker rejections. Tokens and dollars per piece of work read "Tokens and dollars, each counted on its own: …", never "By unit, never added together".

Per-campaign cost exists (observed: `src/dashboard/supervisor.mjs:183`, `src/dashboard/supervisor.mjs:192`). Per-step cost is **unknown**: it depends on whether each AI worker's run records one (#10). Slice S7 shows per-step cost only where it is recorded and says "not reported" otherwise.

### 4.11 Add project (after project connection exists)

- **Question.** Which folder should AIWorks work on?
- **First visible.** A folder field, then what AIWorks found: "Git repository with GitHub remote example-org/sampleapp", "Git repository, no GitHub remote", or "Ordinary folder, no Git".
- **Primary action.** "Connect project".
- **In details.** The checks run and their results.

Checking a folder that is already connected says "This folder is already connected as "<name>"." with "Open "<name>"", checked as the kind it was connected as: a GitHub checkout connected as a Local Git project is the same project, not a changed one. A folder at that place that now holds another project says so, with its folder name and "Open "<name>"", where that project's Now has Check again and Disconnect. A sentence on this screen names "Check again" only when the code offers that button here; otherwise it names "Check folder" (aiworks#11 review 5 G8).

This needs the supervisor's project connection API (#7). A browser page cannot pick a local folder path, so the folder is typed or pasted, and the server checks it. The full path is sent once, to the connection API, and is never served back: the UI shows the folder name only ([§10.2](#102-what-the-new-screens-add)).

---

## 5. Wireflows

Each flow is written as screen → what the owner sees → what they do. "Today" marks steps that work on today's data. "After Sn" marks steps that wait for a slice in [§11](#11-implementation-slices).

### 5.1 First run, no project

1. The owner opens AIWorks. **Projects** shows the empty state ([§7.1](#71-empty)).
2. Before S11: the text says projects appear when this computer's AIWorks settings list a repository. There is no button. Settings › Projects shows the same.
3. After S11: one button, "Add project", opens **Add project** (flow 5.2 or 5.3). Settings › Projects says the same sentence, with "Add project" as a link, not a button: Settings has no primary action (aiworks#11 review F7).
4. With one project connected, AIWorks opens its **Now** screen: "No work yet" with "Start work".

### 5.2 Adding a GitHub project (after S11)

1. **Projects** → "Add project".
2. **Add project**: the owner pastes `C:\example\sampleapp`. AIWorks shows "Checking the folder…" within a second (UX-001 immediate acknowledgement).
3. AIWorks finds "Git repository with GitHub remote example-org/sampleapp, main branch main". The project is listed in the owner's project rules, so it reads "Ready".
4. "Connect project" → **Now** for sampleapp: "No work yet" → "Start work".
5. If the project rules do not list the project: "This project is not listed in your project rules yet, so AIWorks cannot start work on it. You decide which projects AIWorks may work on: listing it in your project rules lets AIWorks start work on it. Your project rules are kept outside AIWorks, in a folder on this computer that the AIWorks configuration file names. Then check again." No button: the fix is outside AIWorks. The copy says "your project rules", not the governance platform's placeholder name, which the owner does not know (aiworks#11 review 4 F4). It says who decides, what listing allows and where the rules are, because "Adding it there is done outside AIWorks" named no place (aiworks#11 review 5 G3). Once connected, such a project's Now and Work say the same sentence and offer no Start work, since work cannot start there; Settings › Diagnostics adds the code `REGISTRY_MISSING`.
6. The same rule holds when Add project cannot finish for a reason outside the page: no project rules on this computer, no Git, or a configuration file that names another folder for the same repository. The sentence says what is missing and that the fix is outside AIWorks, then offers only "Check again". It never offers "Open Settings": Settings only shows what the machine has ([§4.3](#43-settings)) and has no control for these (aiworks#11 review F1; copy in PROJECT_CONNECTION §8.1 and §8.2).

<a id="53-adding-a-plain-folder-after-s11-starting-work-waits-for-d2-and-q2"></a>

### 5.3 Adding a plain folder (after S11)

Built in slice UI17 (plan §6.7), on the owner's decisions of 2026-10-16 (#24, #32, results by Apply).

1. **Projects** → "Add project". The owner pastes `D:\Notes\recipes`.
2. AIWorks finds "Ordinary folder, no Git" and says: "AIWorks will never change this folder directly. It works on its own copy and asks you before applying a checked result." (plan §3.1) It adds: "After you connect it, confirm its rules on its Now screen. Then you can plan work here and approve it."
3. "Connect project" → **Now**: "Connected. Confirm this project's rules on this page before AIWorks plans or starts work here." Work says the same sentence, and Start work offers no plan. The details say how work goes here: "The rules say which rules AIWorks follows in this folder; you confirm them once, for up to 12 months. You ask for a plan and approve it here; AIWorks then works on its own copy, and an independent checker checks each result. Nothing in your folder changes until you press Apply on a checked result, and Undo apply puts it back." Needs me names the project until its rules are confirmed. Settings › Diagnostics names the decisions in machine words: D2, the project rules (AIWorks issue #24), and D4, the dashboard approval (AIWorks issue #32). Decision codes and issue numbers stay out of the project's screens (aiworks#11 review 5 G3). The notice after connecting says only "Connected "<name>"." (review 5 G2).
4. **Confirm this project's rules.** The owner reviews them on Now and confirms by typing the project's name (UI16). Now then reads "Ready. Plan work here: nothing in your folder changes until you press Apply." with "Plan work".
5. **Plan work** offers Plan and do from a description only: a project without GitHub has no issues or pull requests. "Ask for a plan" stores the request; the plan appears on **Review**, which says "Release: Review only. AIWorks stops when a result passes the check. Nothing in your folder changes until you press Apply on it, and Undo apply puts it back."
6. **Approve and start** records the owner's approval of exactly that plan and starts it (D4: no signing key). A press from a program AIWorks started is refused and nothing is recorded. **Work** then lists the steps in plain words.
7. When a step passes the independent check, **Now** reads "**All steps are finished.** A checked result is ready to apply. Nothing in your folder has changed yet." with "See results". **Results** shows the result as "Ready for your review" with **Apply**. Apply reads the folder again first; if a file the result touches changed since AIWorks copied it, nothing is written and the files are named. After Apply the row reads "Applied to your folder" with **Undo apply**, which puts back what was there. No pull request is ever shown. Apply is an owner action under Review only, never Auto Release.

### 5.4 Starting work

1. **Now** → "Start work" → **Start work**.
2. Today (after S9): the owner writes the goal, picks "A GitHub issue" → #443, keeps "Plan only" and presses "Ask for a plan".
3. The page shows the receipt in place, headed "Your plan request from Start work": "Sent · AIWorks received your request at 12:31". The notice after sending says the same. No receipt or notice carries a message number: the page counts messages differently, so a number would not match what the owner sees (aiworks#11 review 5 G16). Then "Read at 12:32", then "Answered · Read the plan" in the local dashboard. Planning writes nothing to GitHub (AW-004, amended 2026-10-13).
   While it waits, the receipt promises a time only when the page knows something reads requests (the request reader holds a live lease): "AIWorks is running on this computer and usually starts on a request within a minute". Otherwise it says "AIWorks reads it when it next runs on this computer; this page can't tell when that will be", or that AIWorks has stopped (aiworks#11 review 4 F12). When a read ends without an answer, the receipt says why in owner words, the same words as a step's last result on Work: "usage limit", "AI worker sign-in", "AI worker unavailable (run not counted)", never "provider" (aiworks#11 review 5 G13).
4. With "Plan and do" (after S10): "Ask for a plan" leads to **Review** when the plan is ready.

### 5.5 Approving (after S10 and Q1)

1. **Review** shows goal, steps, overlaps, limits and "Release: Review only".
2. "Approve and start". The button reads "Starting…" until the server answers.
3. On success: **Work**, with "Approved at 12:40 · waiting for AIWorks to pick it up" (today's grace-period wording; observed: `src/dashboard/owner.mjs:212-214`).
4. On a conflict (the plan changed): "This plan changed since you opened it. Review it again." The page reloads the plan and keeps the owner's place.

### 5.6 Watching

1. **Projects**: the row says "Working on: Contracts import · 4 of 9 steps have results".
2. → **Now**: the same sentence, "Open current work".
3. → **Work**: the running step at the top: "Being built by Claude · working normally · last activity 1 min ago".
4. → **Step**: progress counts and earlier attempts. "Send guidance" queues a note for the next run (today's instruction command, observed: `src/dashboard/supervisor.mjs:329-332`).

### 5.7 A blocked step

1. **Projects** and **Needs me** both list "Decision needed · <step outcome>".
2. → **Step**: "Stopped: needs your decision" and the reason in supervisor words, for example "the independent checker still rejects it after 3 repair rounds; decide whether to accept the gap, narrow the step or allow more rounds, then check it again" (observed: `src/dashboard/supervisor.mjs:115`).
3. Primary action: "Open the step issue". After deciding, the owner presses "Check again" in the More menu.
4. The row leaves Needs me when the supervisor clears the block. Nothing is hidden because the owner looked at it.

### 5.8 A finished result

1. **Now**: "All steps are finished · 2 pull requests wait for your review · 3 merged". Primary action: "See results".
2. → **Results**: "Waiting for your review (2)" first. Each row: "Pull request open · waiting for your review", then "Passed the check at this commit · no conflicts · all 3 CI checks passed".
3. "Review pull request #465" opens GitHub. Merging happens on GitHub; AIWorks never merges (AW-001).
4. After the merge and the next GitHub refresh, the row moves to "Merged 12 Oct · Release follows sampleapp's release policy".

---

## 6. Responsive and keyboard rules

### 6.1 Width

Designed at **320 CSS px first**, then widened.

| Width | Layout |
| --- | --- |
| 320–599px | One column. A bottom bar with Projects, Needs me and Settings, each with a label. The project's four tabs sit under its name and fit without scrolling ("Now", "Work", "Results", "Cost"). Rows are stacked, never tables. |
| 600–959px | One column with more room. Rows may show the state on the same line. |
| 960px and up | A side bar holds Projects, Needs me and Settings, and the project list under them. The project tabs are a top bar in the content. |
| 1600px and up | Today's wide-screen rules are kept: wider column and larger scale (observed: `src/dashboard/public/dashboard.css:224-231`). |

Rules:

- No sideways scroll at any width: `scrollWidth` equals `innerWidth` at 320px.
- Nothing exists at only one width. Every action at 1440px is also there at 320px.
- Touch targets are at least 44 by 44 CSS px.
- Content and actions survive 200% text size.
- Long names wrap; they never become one-letter columns (the 390px header bug in #4).
- Today the bottom bar starts at 520px and the side bar narrows to icons at 850px (observed: `src/dashboard/public/dashboard.css:244-251`, `src/dashboard/public/dashboard.css:266`). The new layout replaces these breakpoints.
- The page stays light with an explicit background (observed: `src/dashboard/public/index.html:6`, `src/dashboard/public/dashboard.css:5`). A dark theme is out of scope.
- Reduced motion is respected (observed: `src/dashboard/public/dashboard.css:321`).

### 6.2 Keyboard and screen reader

- The skip link stays first (observed: `src/dashboard/public/index.html:12`).
- Every destination is a link (`<a href="#/…">`), not a button, so it opens in a new tab and Back works. Today the navigation is buttons (observed: `src/dashboard/public/index.html:17-22`).
- The current place has `aria-current="page"` in both the global bar and the project tabs (observed today for the global navigation: `src/dashboard/public/dashboard.js:81-84`). Project tabs are links, not an ARIA tablist, because each has its own address.
- On a route change, focus moves to the new screen's `<h1>` (with `tabindex="-1"`), and the page title becomes "<Screen> · <Project> · AIWorks".
- Focus order follows reading order. The primary action comes right after the state sentence.
- A visible focus ring on every focusable element (observed: `src/dashboard/public/dashboard.css:26`).
- Dialogs (Cancel work, Send guidance) move focus to their first field. Escape closes them, and focus returns to the button that opened them, as today (#4 live review).
- The 5-second refresh never moves focus and never announces itself. The state sentence of the current screen sits in a polite live region and is announced only when its text changes. Today's refresh keeps focus on the same element (observed: `src/dashboard/public/dashboard.js:623-645`).
- State is never told by colour alone: every state has its word.
- No single-key shortcuts.

---

## 7. State copy

Exact English. `<…>` is filled from data. "Primary" is the one primary action in that state.

None of these texts say merged, deployed, released, live, done or accepted unless the matching GitHub or release evidence is recorded ([§2.3](#23-words-for-result-states)).

### 7.1 Empty

| Where | Copy | Primary |
| --- | --- | --- |
| Projects, before S11 | **No projects yet.** Projects appear here when this computer's AIWorks settings list a repository. Adding a project from this page is not built yet. | none |
| Projects, after S11 | **No projects yet.** Add a folder on this computer. It can be a GitHub repository, a local Git repository or an ordinary folder. | Add project |
| Now, no work | **No work yet.** Tell AIWorks what you want done in <project>. | Start work |
| Needs me | **No work is blocked on you right now.** Keeps today's rule that calm covers only blocking items, and says "work" because Needs me checks work only: project setup is said on Add project and Projects ([§4.2](#42-needs-me)). Reports and merged work are on Results, never named here. | none |
| Needs me, a project held up by the owner's decisions | **No work is blocked on you right now, but <Recipes> waits for your decisions before work can start.** Then one row per such project: "<Recipes> · Can't start work until your decisions are made. Its Now says which, and where each is made. Open <Recipes>" ([§4.2](#42-needs-me); aiworks#11 review 5 G7). | none (each row links to the project) |
| Results, nothing yet | **No results yet.** Results appear here when a step finishes and passes the independent check. | none |
| Cost, no runs | **No cost yet.** Nothing has run for this project. | none |

### 7.2 Disconnected

| Case | Copy | Primary |
| --- | --- | --- |
| The page cannot reach the dashboard (observed today as "Disconnected · controls disabled": `src/dashboard/public/dashboard.js:701`) | **Can't reach AIWorks on this computer.** Showing what was loaded at <12:31>. Buttons are off until it reconnects. Trying again every 5 seconds. | none |
| The dashboard cannot read AIWorks' records (observed: `src/dashboard/supervisor.mjs:144`, `src/dashboard/supervisor.mjs:268`) | **AIWorks can't read its work records right now.** What you see may be out of date. Buttons are off until it can read them again. | none |
| AIWorks stopped on this computer: the computer-wide state the supervisor reports is "stopped" (no lease live for a minute; observed: `src/supervisor/api.mjs` `supervisorLiveness`), and the work's own lease ended over 5 minutes ago (observed: `src/dashboard/owner.mjs` `RESTART_GRACE_MS`) | **AIWorks has stopped on this computer at about <02:24>.** No new step starts. If nobody is updating it right now, sign out of this computer and sign in again, or restart the computer: AIWorks starts again by itself when you sign in. If AIWorks still does not start, whoever set up AIWorks on this computer needs to look at it. | none |
| Within the grace, or while AIWorks restarts (the computer-wide state is "restarting") | **AIWorks is a few minutes late checking in.** This is normal during a restart or an update. Nothing for you to do yet. | none |
| AIWorks runs (another lease is live), but this work's lease ended over 5 minutes ago | **AIWorks is running, but last checked on this work at about <07:17>.** Other work goes on. This work does not move until AIWorks checks on it again. If it stays like this, sign out of this computer and sign in again, or restart the computer: AIWorks starts again by itself when you sign in. If that does not help, whoever set up AIWorks on this computer needs to look at it. | none |
| AIWorks runs, but has not picked up this approved work 5 minutes after it was approved | **Approved at <09:00>; AIWorks is running, but has not picked it up.** Nothing of it starts until AIWorks picks it up. If it stays like this, sign out of this computer and sign in again, or restart the computer: AIWorks starts again by itself when you sign in. If that does not help, whoever set up AIWorks on this computer needs to look at it. | none |

Liveness is read per piece of work, from its own lease, but "AIWorks has stopped" is one fact about the computer. Only the computer-wide state may say it (aiworks#11 review 4 F2). One piece of work whose lease lapsed while AIWorks runs is that work's own state: one Needs me item under its project, with the one time its lease ended, and the same sentence on Now and Work. When AIWorks itself stopped, it is said once: the one Needs me item under "AIWorks itself", with its time. The Needs me banner appears only when no such item says it.

### 7.3 No worker

| Case | Copy | Primary |
| --- | --- | --- |
| Every allowed AI worker is waiting for a usage limit (observed: `src/dashboard/supervisor.mjs:186`, `src/dashboard/supervisor.mjs:199`) | **Waiting for an AI worker to be free.** <Claude> can start again at <14:05>. Work continues by itself. Nothing for you to do. | none |
| No allowed AI worker can run on this computer (observed reasons: `src/dashboard/supervisor.mjs:201-208`) | **No AI worker can run this work on <workstation>.** <Codex is not set up on this computer. Cursor is not available on Windows.> AIWorks can't fix this by itself. See Settings › AI workers. | none (the fix is on the computer) |
| Nothing is running right now, and no reason is recorded | **No AI worker is busy on this project right now.** <next step> starts when it is ready. | Open current work |

"Not set up" is listed in Needs me only when the supervisor records a blocker for it (observed: blocker items, `src/dashboard/owner.mjs:259-262`). A usage-limit wait is never listed there (AW-002).

### 7.4 GitHub stale

| Case | Copy |
| --- | --- |
| Data older than 5 minutes (observed: `src/dashboard/owner.mjs:23`, `src/dashboard/owner.mjs:39-44`) | **GitHub data from <12:31>; refreshing.** Pull request states may be out of date, so nothing is marked ready to merge. |
| The last refresh failed | **GitHub data from <12:31>; the last refresh failed, retrying.** Pull request states may be out of date, so nothing is marked ready to merge. |
| Only the cache from startup | **GitHub data from <12:31>, saved before AIWorks restarted; refreshing.** |
| Never loaded | **Checking GitHub…** The state of <3> results is not known yet. |

Stale data never supports "ready to merge" (observed: `src/dashboard/owner.mjs:88`). The note appears on the row or screen that uses the data, not as a page-wide banner. No primary action: the refresh is automatic.

Today's header can say "Execution live · syncing GitHub…" for minutes (#4; observed: `src/dashboard/public/dashboard.js:694-696`). The header keeps only "Page connected" or the disconnected text ([§3.4](#34-global-frame)).

### 7.5 Paused

| Case | Copy | Primary |
| --- | --- | --- |
| Paused, AIWorks running (observed: `src/dashboard/public/dashboard.js:280-284`) | **Paused since <10 Oct 22:58>.** No new step starts. A step already running may finish. Reason given: "<reason>". | Resume |
| Paused, AIWorks stopped | **Paused since <10 Oct 22:58>, and AIWorks has stopped on this computer at about <02:24>.** Nothing can resume until it runs again. If nobody is updating it right now, sign out of this computer and sign in again, or restart the computer: AIWorks starts again by itself when you sign in. If AIWorks still does not start, whoever set up AIWorks on this computer needs to look at it. | none |
| Paused, AIWorks running, but not checking on this work ([§7.2](#72-disconnected)) | **Paused since <10 Oct 22:58>; AIWorks is running, but last checked on this work at about <07:17>.** It can't resume until AIWorks checks on it again. If it stays like this, sign out of this computer and sign in again, or restart the computer: AIWorks starts again by itself when you sign in. If that does not help, whoever set up AIWorks on this computer needs to look at it. | none |

A pause is neutral. It is not counted in Needs me (observed: `src/dashboard/owner.mjs:268-271`).

### 7.6 Running

| Case | Copy | Primary |
| --- | --- | --- |
| Builder working | **Working on: <step outcome>.** The builder (<Claude>) started at <12:10> · last activity <2 min> ago. | Open current work |
| Checker working | **Checking: <step outcome>.** An independent checker (<Claude>) is reviewing the result. | Open current work |
| Possibly stuck (observed rule: `src/dashboard/public/dashboard.js:147-153`) | **Possibly stuck: <Step outcome> has made no progress for <25> minutes.** AIWorks retries by itself if the worker stops. | Open current work |
| Waiting for a merge (observed: `src/dashboard/supervisor.mjs:23`) | **Waiting for you to merge <"Contracts import">.** <"Search page"> starts after it is merged. | Review pull request #<N> |
| Waiting for AIWorks to pick it up (observed: `src/dashboard/owner.mjs:212-214`) | **Approved at <12:40>; waiting for AIWorks to pick it up.** Nothing for you to do yet. | none |

The possibly-stuck words lead the project's row on Projects too ([§4.1](#41-projects)), so a stuck worker never reads as normal work there (aiworks#11 review 4 F14). Possibly stuck is not a Needs me item, so it must not depend on leading: when Needs me items or a pause lead Now, each possibly stuck and working worker is still a line under "Also in this project" ([§4.4](#44-now-inside-a-project)), and the project's row says "Also: <2> AI workers possibly stuck · …" after its Needs me count (aiworks#11 review 5 G5).

### 7.7 Blocked

| Case | Copy | Primary |
| --- | --- | --- |
| A step needs the owner's decision (observed: `src/dashboard/supervisor.mjs:114`) | **Stopped: needs your decision.** <Step outcome>: <reason in supervisor words>. | Open the step issue |
| A step stopped after failed attempts (observed: `src/dashboard/supervisor.mjs:117-118`) | **Stopped: <5> attempts failed.** <Step outcome>. It will not retry by itself. Fix the cause, then check it again. | Open the step issue |
| The same, when the last result was "invalid result" (Step screen, beside the last result) | Invalid result: the builder finished, but what it handed back failed AIWorks' own checks, for example no commit, a commit that does not start where the step began, or an answer not in the form AIWorks reads. Nothing it made was used. Fixing the cause is done outside this page. What each step must deliver, and which AI workers may do it, are set in the plan approved for this work. That plan is a file kept on this computer, and this page can't change it. Whoever set up AIWorks on this computer changes it: they can let another AI worker do this step, or replace this work with a plan where the step is smaller or clearer. If a clear step keeps failing this way, AIWorks itself needs a fix, which is for AIWorks' maintainers. When the cause is fixed, choose Check again. (For the independent checker: "…for example it checked an older version of the step… The step's change is kept.") The last sentence is said only where the Step screen shows Check again for the step. | Check again |
| The work is stopped by a recorded blocker (observed: `src/dashboard/supervisor.mjs:189-190`) | **Stopped: AIWorks needs a fix on this computer.** <reason>. What to do: <action>, for example "See Settings › Diagnostics for what it recorded, and fix it, then choose Check again." | Check again, while the work takes it; otherwise none, and the action does not name it |
| Other steps continue (observed: `src/dashboard/supervisor.mjs:42`) | **One step is stopped; the others continue.** <Step outcome> needs your decision. | Open the step issue |

"The plan" was "the plan on this computer" until aiworks#11 review 5 G4: the owner could not tell what or where that was. The copy now says what it is (the plan approved for this work: what each step must deliver and which AI workers may do it), where it is kept (a file on this computer), who changes it (whoever set up AIWorks on this computer) and that this page cannot. A step's wording is fixed once its work is approved ([the runbook](../SUPERVISOR.md)), so the copy offers another AI worker, or a new plan, never an edit in place.

An advice sentence names only a control on its own screen, or carries it (aiworks#11 review 5 G8). A Needs me card has no More menu, so the card for work a recorded blocker stopped carries its own Check again after the sentence, and the project's Now has it as the primary action. Where the work takes no command, neither the button nor the words appear.

### 7.8 Finished

| Case | Copy | Primary |
| --- | --- | --- |
| Pull requests wait for review | **All steps are finished.** <2> pull requests wait for your review · <3> merged. | See results |
| Everything merged, all states known (observed rule: `src/dashboard/owner.mjs:124`, `src/dashboard/owner.mjs:135`) | **All steps are finished and merged.** Release follows <sampleapp's> <release policy \| standing deploy authorization>. | See results |
| Some states unknown | **All steps are finished.** The GitHub state of <2> results is not known yet, so this is not settled. | See results |
| A result's evidence unresolved (OWNER_UI_V2 WP4): a criterion failed or not checked, a blocking finding, or changes requested | **All steps are finished, but not complete.** <1> result has criteria not checked, failed or open findings. Review its evidence before you accept. | See results |
| Reports only | **All steps are finished.** <2> reports posted for you to read. | See results |
| Some closed without merging | **All steps are finished.** <1> pull request was closed without merging, so that work is not in <sampleapp>. | See results |
| Local project (UI17) | **All steps are finished.** The checked result is ready to apply. Nothing in your folder has changed yet. | See results |
| Cancelled (observed: `src/dashboard/owner.mjs:223`) | **Cancelled.** <4> of <9> steps had results before it stopped. | See results |

"Done" is never used for a step whose pull request is open. Today's step badge vocabulary still has "Done" for roadmap items (observed: `src/dashboard/public/dashboard.js:2`). Those move to Diagnostics.

---

## 8. Data per screen

"Today" means the field already exists in the dashboard's `/api/state` response (observed: `src/dashboard/server.mjs:48-56`). "Dashboard read" means a new read-only query inside `src/dashboard/`, using the read-only store connection (observed: `src/dashboard/supervisor.mjs:147-148`). "Supervisor API" means a change outside `src/dashboard/` that the slice names as a dependency. Short file names in this table (`supervisor.mjs`, `owner.mjs`, `server.mjs`, `roadmap.mjs`) are files in `src/dashboard/`; every reference is observed at the task base.

| Screen | Needs | Today (observed) | Missing, and from where |
| --- | --- | --- | --- |
| Projects | project list, kind, one state, one action | target repository per campaign `supervisor.mjs:172`; configured repositories `roadmap.mjs:24-29`; owner items `owner.mjs:228-294`; liveness `owner.mjs:218-219` | grouping and state per project: dashboard (S2). Local Git and folders, connection state: **Supervisor API** #7 |
| Needs me | items grouped by project | items with `campaignId` and `repository` `owner.mjs:226`; headline `owner.mjs:297`; also-line `owner.mjs:313-322` | grouping only: dashboard (S3) |
| Settings | computer, AI workers once, release mode | host `server.mjs:26`; providers per campaign `supervisor.mjs:194-210`; Cursor host limit `supervisor.mjs:208` | per-computer merge of providers: dashboard (S8). Which CLIs are configured: dashboard read of `config.json` command **names only** (`supervisor.mjs:12-14` reads it today). Release mode: fixed "Review only" until #13 |
| Messages | messages and receipts | `supervisor.mjs:257-266`; send `supervisor.mjs:273-287` | none |
| Diagnostics | journal, issues and PRs, roadmap | journal `supervisor.mjs:244-254`; roadmap and work `roadmap.mjs:257-258` | none |
| Now | goal, sentence, progress, since-last-look | purpose `owner.mjs:147-155`; counts `owner.mjs:224-225`; recent `owner.mjs:325-340`; next action `supervisor.mjs:32-43` | per-project recent summary: dashboard (S4) |
| Start work | project, goal, optional issue or PR | issues and PRs per repository `roadmap.mjs:257-258`; message path `supervisor.mjs:273-287` | plan request with structure: dashboard (S9) composes a message. "Plan and do" and plan drafts: **Supervisor API** #8 |
| Review | proposed plan, overlaps, limits | none | **Supervisor API** #8 (plan draft, admission), duplicate check #5 |
| Work | steps, states, waits, agents | tasks `supervisor.mjs:224-234`; agents `supervisor.mjs:235-242`; waits `supervisor.mjs:20-28`; commands `supervisor.mjs:289-341` | wait sentences that name step outcomes: dashboard (S5) |
| Step | state, progress, last result, guidance, history | task fields and `lastOutcome` `supervisor.mjs:162-170`; progress `supervisor.mjs:76-106`; instructions `supervisor.mjs:211-223` | per-step attempt history: dashboard read of `journal` and `operations` for one task (S5) |
| Results | lifecycle per result | delivery `owner.mjs:59-75`; readiness `owner.mjs:83-101`; release rule `owner.mjs:107-108` | changes requested: dashboard, add review state to the read-only `gh pr list` fields (S6). Released and accepted: **unknown** until #13 and #4 record evidence. Local results: #7, #8 |
| Cost | reported cost, unreported runs | `recordedCostUsd`, `runsUsed`, `budget.unknownCostRuns` `supervisor.mjs:183`, `supervisor.mjs:192` | per-step cost: dashboard read where recorded (S7); completeness **unknown** (#10) |
| Add project | folder check, connect | none | **Supervisor API** #7 |

---

## 9. What today's views become

`dashboard.js` below is `src/dashboard/public/dashboard.js`; every reference is observed at the task base.

| Today (observed: `src/dashboard/public/dashboard.js:73-78`) | Becomes | Old address goes to |
| --- | --- | --- |
| **Overview**: since-last-look, Needs you, campaign cards, Live now, platform roadmap, finished list, activity, messages (`dashboard.js:638-644`) | Split. Needs you → **Needs me**. Since-last-look → each project's **Now**. Campaign cards → **Now** and **Work**. Live now → **Work**. Finished list → **Results**. The four metrics (`dashboard.js:104-114`) go: "Platform roadmap items" → Diagnostics; "Needs you" → the Needs me count; "Agents working" → Work; "Cost so far" → **Cost**. | `#/projects` |
| **Plans**: campaign plans, then the governance provider roadmap (`dashboard.js:574-583`, `dashboard.js:533-555`) | Campaign plans → each project's **Work**. The platform roadmap → **Settings › Diagnostics**. It is governance provider's plan, not one of the owner's work items. | `#/settings/diagnostics` |
| **Issues & PRs** (`dashboard.js:609-618`) | Per project: the issue and pull request picker in **Start work**, and pull request links in **Results**. The full list → **Diagnostics**. | `#/settings/diagnostics` |
| **Agents** (`dashboard.js:634-637`) | Who is working → **Work** and **Step**. AI workers → **Settings**, once per computer. | `#/projects` |
| **Messages** (`dashboard.js:394-406`) | **Settings › Messages**. The header keeps a "Messages" link. | `#/settings/messages` |
| **Activity** (`dashboard.js:476-503`) | A step's own events → **Step**. The full journal → **Diagnostics**. | `#/settings/diagnostics` |

Nothing is deleted. Every fact shown today is still reachable, and its tests keep their assertions.

---

## 10. Security and boundaries kept

### 10.1 Kept exactly

The new screens keep every request check the server has today:

- **Loopback only.** It binds to `127.0.0.1` (observed: `src/dashboard/main.mjs:35`; AW-003).
- **Exact Host and Origin.** The Host header must be the loopback origin. A present Origin must match it. Cross-site requests are refused, except a plain top-level page load of `/` (observed: `src/dashboard/server.mjs:20-21`, `src/dashboard/server.mjs:39-40`).
- **Response headers** on every response (observed: `src/dashboard/server.mjs:31-34`):
  - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
  - `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`;
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- **Commands.** Every POST needs the exact Origin and the per-process CSRF token, compared in constant time (observed: `src/dashboard/server.mjs:24`, `src/dashboard/server.mjs:60-63`). It must be JSON (observed: `src/dashboard/server.mjs:64`) of at most 16 KiB (observed: `src/dashboard/server.mjs:65-70`). Request and header timeouts are 10 seconds (observed: `src/dashboard/server.mjs:87-88`).
- **Commands bound to what was seen.** Each command carries the version, authorization version and scope digest, and a changed state is a conflict. A request ID makes a repeat safe (observed: `src/dashboard/supervisor.mjs:311-319`). The allowed actions stay pause, resume, recheck, cancel and instruct (observed: `src/dashboard/supervisor.mjs:292`).
- **Reads are read-only.** GET never creates a missing store (observed: `src/dashboard/supervisor.mjs:144`, `src/dashboard/supervisor.mjs:147`).
- **What is never served.** Raw worker output, prompts, session IDs, local workspace paths, secrets and raw error text. Text is run through `safeText`, and links are limited to GitHub (observed: `src/dashboard/supervisor.mjs:18`, `src/dashboard/roadmap.mjs:20-23`).

### 10.2 What the new screens add

- New script files are added to the static allowlist one by one, with the same headers. No directory is served (observed allowlist: `src/dashboard/server.mjs:10-14`).
- New read-only GET endpoints, if any, go through the same Host, Origin and cross-site checks. They return only allowlisted fields.
- The project's folder **name** may be shown. Its full path is not served. Showing full paths would change the documented rule in [OPERATIONS_DASHBOARD.md](../OPERATIONS_DASHBOARD.md#local-access-boundary) and needs its own security review.
- `sessionStorage` drafts stay in the owner's browser for this origin. The server's credential check still refuses a draft that looks like a secret when it is sent (observed: `src/dashboard/supervisor.mjs:296-297`).
- New POST actions (S10 "Approve and start", S11 "Connect project") use the same CSRF, Origin, JSON, size, version-binding and request-ID rules. They call a reviewed supervisor API. The dashboard never writes campaign or project records itself.

### 10.3 Release mode

Settings shows, per project:

- **Review only** · On. "AIWorks stops when a result passes the check and is published. You merge and release."
- **Auto Release** · Off · "Not available. Turning this on needs your separate release approval for this project, which has not been given." (#13, D5-gate)

There is no switch until the D5-gate decision and #13 exist. Text only, no disabled control.

A project without GitHub is listed too, with one line and no modes: "Release does not apply to a project without GitHub: a checked result changes your folder only when you press Apply on it, under Review only." So Release mode lists every project Settings lists (aiworks#11 review 5 G10).

### 10.4 Powers not enabled by this design

| Power | State in this design | Waits for |
| --- | --- | --- |
| Starting work from the dashboard | designed (S10), built switched off | #8 supervisor admission API, owner question Q1 |
| Local admission without GitHub | built: STA16, switched on by STA17, dashboard routes UI17 | Decided 2026-10-16 (D2 #24, D4 #32). On a running dashboard every local approval and Apply is refused (fails closed) until a process lookup for the caller check is wired in |
| Auto Release | text only, no control | D5-gate (owner), #13 |
| Telegram delivery of Needs me | not designed here; Needs me stays the one source | #1, owner question Q3 |

---

## 11. Implementation slices

Each slice is one reviewable PR. Unless a supervisor API is named as a dependency, a slice changes `src/dashboard/**` only, plus its own tests under `tests/dashboard/` and the matching section of [OPERATIONS_DASHBOARD.md](../OPERATIONS_DASHBOARD.md). All tests are synthetic: disposable stores (as in `tests/dashboard/claims.test.mjs:20-34`), a synthetic `gh` and no network, model or GitHub calls. No slice removes or weakens an existing assertion. Where a slice changes a sentence that a test pins, the test changes to the new sentence and keeps every condition it checks (fresh data, head match, CI and so on). Every slice ends with `npm run check`.

Order: S0 first, then S1. S2–S8 may run in parallel after S1, with one owner per file. S9 needs S1. S10–S13 wait for decisions.

### S0. Review fixture

- **Outcome.** A synthetic store and a fake `gh` that show every state in §7, so a disposable dashboard can be reviewed without live data.
- **Files.** `tests/dashboard/fixtures/review-store.mjs` (new; the test runner skips `fixtures`, observed: `scripts/run-tests.mjs:10`), `tests/dashboard/fixtures/review-gh.mjs` (new).
- **Tests.** `tests/dashboard/review-fixture.test.mjs`: the fixture builds, `supervisorSnapshot` and `ownerView` show one piece of work per state, and the fake `gh` returns parseable JSON offline.
- **Acceptance.** The §13 protocol runs against today's dashboard (baseline) on port 4319.
- **Depends on.** Nothing. **Waits for a decision.** No.

### S1. Navigation shell

- **Outcome.** Projects, Needs me and Settings as the global navigation; project tabs; hash addresses; old addresses redirected; route, scroll, focus and drafts kept as in §3.3; the §6 layout at 320px.
- **Files.** `src/dashboard/public/index.html`, `src/dashboard/public/dashboard.css`, `src/dashboard/public/dashboard.js`, new `src/dashboard/public/router.mjs` (pure route parsing, importable by Node), `src/dashboard/server.mjs` (one allowlist entry).
- **Tests.** `tests/dashboard/router.test.mjs`: parse and format every address, legacy redirects, unknown addresses → Projects. `tests/dashboard/dashboard.test.mjs`: the new file is served with the same headers and refused cross-site. `tests/dashboard/presentation.test.mjs`: links, not buttons, for destinations; `aria-current`; no width-only actions in the CSS.
- **Acceptance.** Every old view's content is reachable from a new address. Back and Forward restore scroll. A reload keeps the route and the drafts.
- **Depends on.** S0 for review. **Waits for a decision.** No.

### S2. Projects from today's data

- **Outcome.** The Projects screen: one row per GitHub repository with work or configuration, each with one state and one action.
- **Files.** New `src/dashboard/projects.mjs`; `src/dashboard/server.mjs` (adds `projects` to `/api/state`); `src/dashboard/public/dashboard.js`.
- **Tests.** `tests/dashboard/projects.test.mjs`: grouping by repository, case-insensitive; order (needs you, running, others); one state per project; a configured repository with no work shows "No work yet".
- **Acceptance.** Projects never shows a campaign ID at the primary level. A project's state never contradicts its Needs me items.
- **Depends on.** S1. **Waits for a decision.** No.

### S3. Needs me

- **Outcome.** Today's Needs you items, grouped by project, with "AIWorks itself" last, or first when it holds up work in several projects ([§4.2](#42-needs-me)).
- **Files.** `src/dashboard/owner.mjs` (grouping only), `src/dashboard/public/dashboard.js`.
- **Tests.** `tests/dashboard/owner.test.mjs` and `tests/dashboard/claims.test.mjs` keep every current claim. New cases: grouping, counts equal to today's headline count, a usage-limit wait never listed.
- **Acceptance.** Same items and count as today on the S0 fixture.
- **Depends on.** S1. **Waits for a decision.** No.

### S4. Now and the state copy

- **Outcome.** The project's Now screen, and all §7 copy in one module.
- **Files.** New `src/dashboard/copy.mjs`; `src/dashboard/public/dashboard.js`.
- **Tests.** `tests/dashboard/copy.test.mjs`:
  - every state in §7 has text;
  - no primary text contains pipeline, fencing, lease, slots, control plane or campaign declaration;
  - no text for an open pull request contains merged, deployed, released, live, done or accepted;
  - unknown is never "0" or "nothing".
  
  Plus claims tests for the per-project calm rule.
- **Acceptance.** On the S0 fixture each state shows its exact copy and its one primary action.
- **Depends on.** S1, S2. **Waits for a decision.** No.

### S5. Work and Step

- **Outcome.** Work and Step screens; wait reasons named by step outcome; per-step attempt history; Pause, Check again and Cancel in the More menu; Resume as the primary action when paused.
- **Files.** `src/dashboard/supervisor.mjs` (read-only per-step history query and new wait sentences), `src/dashboard/public/dashboard.js`.
- **Tests.** `tests/dashboard/work.test.mjs`: history for one step only, no worker text leaks, wait sentences, the More menu absent on finished work. Existing command tests in `tests/dashboard/dashboard.test.mjs` unchanged.
- **Acceptance.** A blocked step reads as in §7.7. Commands keep version binding and request IDs.
- **Depends on.** S1. **Waits for a decision.** No.

### S6. Results

- **Outcome.** Results grouped by state, the "Passed the check" wording, and a "Changes requested" state from GitHub's review decision.
- **Files.** `src/dashboard/owner.mjs`, `src/dashboard/roadmap.mjs` (adds `reviewDecision` to the read-only pull request fields), `src/dashboard/public/dashboard.js`.
- **Tests.** `tests/dashboard/claims.test.mjs`: ready-to-merge conditions unchanged; changes requested from a synthetic `gh`; merged never reads released.
- **Acceptance.** No result reads merged, released or accepted without the matching evidence.
- **Depends on.** S1. **Waits for a decision.** No.

### S7. Cost

- **Outcome.** Cost per project and per step, with unreported runs counted apart.
- **Files.** `src/dashboard/supervisor.mjs` (read-only per-step cost where recorded), `src/dashboard/public/dashboard.js`.
- **Tests.** None: cost is display, and the test rule in AGENTS.md (owner decision 2026-10-17) removed `tests/dashboard/cost.test.mjs`. The owner review checks that unknown is never $0.00 and unreported runs are counted.
- **Acceptance.** Project totals match today's per-campaign sums.
- **Depends on.** S1, S2. **Waits for a decision.** No.

### S8. Settings and Diagnostics

- **Outcome.** This computer; AI workers once per computer; project connections; release mode as text; Messages; Diagnostics with the journal, issues and PRs, the platform roadmap and Refresh GitHub.
- **Files.** `src/dashboard/supervisor.mjs` (configured command names, never paths), `src/dashboard/public/dashboard.js`.
- **Tests.** `tests/dashboard/settings.test.mjs`: providers merged per computer, no command path in the response, Auto Release shown off with no control. Roadmap tests unchanged.
- **Acceptance.** Every fact of today's Agents, Messages, Activity, Plans and Issues & PRs views is reachable.
- **Depends on.** S1. **Waits for a decision.** No.

### S9. Start work: Plan only

- **Outcome.** Start work with goal, source choice and Plan only, sent as a structured coordinator message, with receipts in place.
- **Files.** `src/dashboard/public/dashboard.js`, `src/dashboard/supervisor.mjs` (message composition, within the 4,000-character limit at `supervisor.mjs:274-277`).
- **Tests.** `tests/dashboard/messages.test.mjs`: message text built from project, goal and issue; credential-like goals refused; repeat with the same request ID acknowledged once.
- **Acceptance.** Plan only never changes a project file or registers work. "Plan and do" shows its not-built line.
- **Depends on.** S1. **Waits for a decision.** No.

### S10. Review and Approve, GitHub projects

- **Outcome.** Plan and do → Review → "Approve and start" for a GitHub project, under AW-005.
- **Files.** `src/dashboard/server.mjs` (one POST route), `src/dashboard/supervisor.mjs`, `src/dashboard/public/dashboard.js`.
- **Dependency (Supervisor API).** A reviewed admission API from #8 that registers a declaration only under private stored authorization and merged runtime code (AW-005), and the duplicate check from #5 and #6.
- **Tests.** `tests/dashboard/approve.test.mjs`: CSRF and Origin required; a changed plan is a conflict; a declaration that differs from its private approval is refused; a repeat with the same request ID is acknowledged once.
- **Acceptance.** No dashboard path registers work that the CLI would refuse.
- **Waits for.** Owner question Q1, and #8.

### S11. Add project

- **Outcome.** Add project for GitHub, local Git and plain folders; the Projects primary action.
- **Files.** `src/dashboard/server.mjs`, `src/dashboard/supervisor.mjs`, `src/dashboard/public/dashboard.js`.
- **Dependency (Supervisor API).** Project connection from #7.
- **Tests.** `tests/dashboard/connect.test.mjs` with disposable folders and git repositories: no file in the folder changes on connect; the full path is never served back; an unregistered GitHub project reads as in §5.2.
- **Acceptance.** An uncoached reviewer adds a plain folder (#11 acceptance).
- **Waits for.** #7. Starting work in a local project also waits for D2 (governance provider) and D4 (owner).

### S12. Local projects: plan, approve and apply

- **Outcome.** Plan only and Plan and do for projects without GitHub; local results with "Ready to apply"; the apply action.
- **Files.** `src/dashboard/**`.
- **Dependency (Supervisor API).** #7, #8, a local reply place for the coordinator, and the local apply operation.
- **Tests.** Synthetic local projects: no pull request ever shown; apply refused on a changed folder.
- **Acceptance.** Plan §1 acceptance for a folder without GitHub.
- **Waits for.** D2 (governance provider) and D4 (owner AW-005 amendment).

### S13. Release mode switch

- **Outcome.** A real Auto Release switch per project, with eligible, blocked and released states.
- **Files.** `src/dashboard/**`.
- **Dependency.** #13 release adapter and evidence.
- **Tests.** The switch absent without a recorded grant; released only with recorded evidence.
- **Acceptance.** Nothing implies that passing the check means deployed.
- **Waits for.** D5-gate (owner) and the governance provider release policy.

### Acceptance runs

After S1–S8, run the §13 protocol: pass A, then B, B2 and C. Findings become fix PRs on the same files. #11 is accepted only when no blocker or must finding stays open.

---

## 12. Owner-reserved questions

Only questions that change a permission or a documented boundary are here. D1, D3, D5 and D9 are settled and are not asked again.

| # | Question | Recommended answer | What it unblocks |
| --- | --- | --- | --- |
| **Q1** | May the local dashboard start (register) work whose plan is merged on AIWorks main, when the owner presses "Approve and start"? Today the documented boundary says no campaign can be registered from the dashboard ([OPERATIONS_DASHBOARD.md, Commands](../OPERATIONS_DASHBOARD.md#commands)). | **Yes,** with the same checks as the CLI `start`: private approved declaration and authorized (AW-005), merged supervisor code, the duplicate check, CSRF and Origin, and a confirmation screen showing goal and limits. It stays loopback-only (AW-003). | S10. With D4, the local half of S12. |
| **Q2** | D4: may a project without GitHub be approved by a tamper-evident local record instead of a private approved declaration? | **Yes, as the narrow AW-005 amendment in [plan §3.2](../PROJECT_WORKSPACE_PLAN.md#32-work-request---one-authorization-autonomous-execution-inside-its-scope-owner-approved-d3):** reviewed, pinned supervisor code stays required; only the declaration's home changes. It goes through its own reviewed decision record. | S12 approval and child steps for local projects. |
| **Q3** | Should Needs me also be sent to Telegram (#1)? | **Not in this program.** Keep Needs me the one source, so #1 can send the same items later without a second list. | Nothing here; keeps #1 simple. |
| **Q4** | D5-gate: which releases may Auto Release make, and where? | **Not now.** Show Auto Release as off and unavailable until a per-project release grant exists ([plan §5.5](../PROJECT_WORKSPACE_PLAN.md#55-separate-auto-release-mode-owner-approved-d5-tracked-13)). | S13. |

**Waits for governance provider (not the owner here).** D2: a local project identity, so a folder without a GitHub remote can be registered without a GitHub pull request per folder. Proposed text for a governance pull request: "Project contract: allow an owner-approved local project identity (stable owner-scoped ID, local authority pointers) recorded in a local overlay validated against inherited policies. The overlay may never waive a governance policy or write the governance checkout." It unblocks starting work in S11 and S12. It is proposed as text only; no governance change is made from here.

Everything else in this document is decided here: the navigation, the copy, the routes, the folder-name-only rule, the draft storage, the "AIWorks itself" group in Needs me, the Diagnostics home for the platform roadmap and the "Passed the check" wording.

---

## 13. Blind review protocol (UX-002 pass A)

Method: EXPERIENCE_REVIEW.md §1 (blind intent pass), §3 (matrix) and §4 (finding record). This section only fills in the AIWorks parts.

### 13.1 Disposable dashboard

The person running the review prepares it; the reviewer never sees these steps.

1. Make a fresh temporary directory, for example with `mkdtemp`. Never use `C:/example/aiworks/.local` or the live data directory.
2. Build the S0 synthetic store in `<tmp>/data/supervisor.db`. It has three made-up projects (`example/shop-app`, `example/recipes`, `example/notes-site`) and covers every §7 state: running, provider wait, paused, blocked on a decision, stopped after failures, finished with open, merged and closed pull requests, reports, unknown GitHub state, and a stopped supervisor. Leases are written with a future expiry, so "running" holds without a live supervisor. A second, empty store covers the first run.
3. Write `<tmp>/data/config.json` with `repositories` for the three projects and `commands.gh` pointing to the S0 fake `gh` (read through `configuredGithubCommand`, observed: `src/dashboard/roadmap.mjs:10-19`). The fake returns fixture JSON and makes no network call. No credentials go in it.
4. Start the dashboard in the foreground on **port 4319**, never 4318:
   `node src/dashboard/main.mjs --data <tmp>/data --port 4319 --cache <tmp>/cache --governance tests/fixtures/governance`
   (options observed: `src/dashboard/main.mjs:12-20`).
5. Check that the page lists only the `example/…` projects before handing it over.
6. After the review, stop that process and delete `<tmp>`. Never start, stop or restart the live supervisor or dashboard.

Commands the reviewer sends change only the synthetic store.

### 13.2 The reviewer

- A fresh context with no repository, shell, plan, issue or design access. It gets only the persona, the situation and a browser at `http://127.0.0.1:4319`.
- **Persona.** "You build several small apps on your own PC. You use an AI tool that works on them for you. You opened its page to see how things are going."
- The expected results stay hidden until the observations are saved.

### 13.3 Tasks

Before each task, the reviewer answers the pass-A questions: Where am I? What brought me here? What one to three things would I try? Which thing on the screen would I use? Can I finish here? If not, where am I sent and why? Did I need to know how the tool works inside?

| # | Situation given to the reviewer | Hidden success check |
| --- | --- | --- |
| T1 | (empty store) "You just installed it. Get started." | Understands that no project exists and how one appears, without a dead end. |
| T2 | "You have ten minutes. What needs you today?" | Names every Needs me item, by project, in under a minute. |
| T3 | "Is the change for 'Search page' in shop-app live for users?" | Says it is merged, or waiting for review, and that AIWorks does not say it is live. |
| T4 | "Ask the tool to plan a new feature for recipes. Don't let it change anything yet." | Finds Start work, chooses Plan only and sees the receipt. |
| T5 | "What is the tool doing on shop-app right now?" | Finds the running step and who works on it. |
| T6 | "Something in notes-site is stuck. What should you do?" | Finds the blocked step, its reason and the one action. |
| T7 | "How much did shop-app's finished work cost?" | Finds the reported total and that some runs did not report a cost. |
| T8 | "recipes was paused for an update. Start it again." | Finds Resume and sees the result. |
| T9 | Repeat T2 at 320px wide, keyboard only. | Same answer; no sideways scroll; focus always visible. |
| T10 | Switch from shop-app to recipes and back, mid-way through writing a plan request. | The draft, the screen and the scroll are kept. |

### 13.4 Record and pass rule

- Each finding uses the UX-002 §4 record, severity and experience code. It names the screen, state, viewport and the dashboard revision reviewed.
- For each screen the reviewer reached, it writes in its own words the question the screen answers. A mismatch with §4 is a finding against this design.
- **Pass:** T1–T10 succeed without knowledge of the tool's internals, and no blocker or must finding is open.
- Order: pass A first, on screenshots and on the running disposable dashboard. Then the constitutional pass (B), the behavioral pass (B2, UX-001) and the visual pass (C) at 320px, about 390px and about 1440px, with 200% text and one keyboard-only pass. The behavioral and visual passes have not run on the dashboard yet (#6).
- Run it once on today's dashboard as a baseline after S0, and again after S1–S8.
- Screenshots show synthetic data only.

---

## 14. Open unknowns

- Whether each AI worker records a cost for every run, which per-step cost depends on (**unknown**; #10).
- The local intake contract for a project with no GitHub (S12); replies stay in the dashboard under AW-004.
- Whether the live workstation dashboard matches the code at `acb9e66` (**unknown**; not checked by this design).

## Implemented visual refresh

The current visual system and canonical UI ownership are maintained in the root
[DESIGN.md](../../DESIGN.md). The owner workflows and evidence rules above remain
binding. The refresh adds a full-width header, compact project rows, a server-derived
attention summary, neutral action cards, and an inline active-worker metric.
The planning entry is labeled **Plan work**; `/start` remains the compatible route.
Only Plan only is available, with the unavailable execution mode explained in a
disclosure. Merge and release permissions are described separately. These changes
introduce no new execution, merge, or release authority.
