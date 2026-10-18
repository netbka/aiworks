# Owner UI v2: goals, decisions and evidence

**Privacy boundary:** this is a design proposal, not a live installation record. Campaign declarations, approval records and installation status stay private under [AW-009](../DECISIONS.md#aw-009---public-commits-contain-no-installation-data). All projects, names, amounts and dates in the previews are fictional.

**Status:** design only. Nothing in this document is built or deployed. It proposes the next shape of the owner UI and the backend work needed to back it. Statements about today's code are **observed** from the source at `b43faa2` (the endpoints, flags and tables named below were rechecked on `fdc4c2f`); none was checked on a running installation, so none is **verified**. Everything else is **planned**.

**Relationship to [OWNER_WORKSPACE.md](OWNER_WORKSPACE.md).** That design stays the authority for state words ([§2.3](OWNER_WORKSPACE.md#23-words-for-result-states)), state copy and the security boundary ([§10](OWNER_WORKSPACE.md#10-security-and-boundaries-kept)). This proposal changes the navigation and adds four models the current UI cannot show: a structured decision, a plan in user terms, acceptance with evidence, and a release step. Where the two disagree, the owner decides; until then OWNER_WORKSPACE.md applies.

Previews: [docs/design/previews/owner-ui-v2/](previews/owner-ui-v2/), one static HTML page and one screenshot per screen, linked to each other.

---

## 1. Product sentence

**You set the goal and answer real questions. AIWorks does the work and shows the evidence.**

The owner acts at three points in the life of every goal: **set the goal, approve the plan, accept the result.** Between them AIWorks plans, builds, checks independently, repairs and recovers on its own, and asks only through a decision. Human attention is the scarce resource: every screen answers "does anything need me?" in its first line.

## 2. Navigation

```
Home                        What changed, and what needs me?
Projects                    Which product?
Needs you                   Which decisions are mine?
  Project ▸ <name>
    Overview   (tab)        Where is the current goal?
    Plan       (tab)        What will be true when this is done?
    Review     (tab)        Does the result do what was promised?
    Releases   (tab)        What reaches users, and what can be undone?
    Knowledge  (tab)        What does AIWorks know about this product?
    Project settings        Under which rules does work run?
Help · Settings             Connections, usage, alerts
```

On a phone, Home, Projects and Needs you sit in a bottom bar. Technical detail (branches, commits, logs, run records) opens in place under "Details" on the screen that needs it; there is no global technical mode.

## 3. Concepts

| Concept | What the owner sees | Today's code |
| --- | --- | --- |
| Project | A product: a folder on this computer, with or without GitHub | `projects` |
| Goal | What should be true when finished, with a reason, priority and horizon (Now, Next, Later) | `campaigns` (no horizon) |
| Plan | What users will be able to do; how we will know it is done (each criterion with its check method); included and later; budget; release mode | `envelope`, `work_drafts` |
| Result | A version ready for acceptance: preview or example, criteria with evidence, "not checked" with a reason, where the owner's eyes matter | `tasks`, `operations` |
| Decision | A question with options and consequences, AIWorks' suggestion and why, what continues meanwhile, what happens without an answer | `blockers` (free text) |
| Release | What changes for users, destination, version, checks, honest restore scope | `releases` (switched off) |
| Knowledge | Facts about the product, each marked confirmed by the owner, found in material or suggested by AI | none |

Technical steps belong to the plan and open under "How AIWorks will do it".

## 4. Control: two settings and one boundary

1. **Work.** After Start work, AIWorks splits the goal, builds, checks, repairs and continues after crashes and limits. Any change to the goal, its criteria, its budget, protected data or the release returns to the owner as a new plan version with the difference shown.
2. **Release.** Manual by default. Automatic release is turned on per project only under an explicit rule that names the destination, allowed changes, required checks and what can be restored (AW-010).
3. **Protected areas.** Paths or topics in a project where any change becomes a decision.

Risk is a label on a result (low, medium, high). It decides what "where your eyes matter" shows and keeps high-risk decisions off the phone. It is not a ladder of trust levels.

## 5. States and colour

Two separate lines, never merged: work (Plan ready → Working / Checking → Waiting → Needs you → Review ready → Accepted) and release (Not released → Publishing → Live, Failed, Status unknown). Colour answers "who has to act": amber for the owner, blue while AIWorks works, grey for waiting under control, green for confirmed, red only for a break the owner must fix. Colour always comes with words. Word rules from [OWNER_WORKSPACE.md §2.3](OWNER_WORKSPACE.md#23-words-for-result-states) hold: "Accepted" only with recorded acceptance, "Live" only with release evidence, unknown is never shown as nothing or green.

## 6. Screens

| # | Screen | It answers | Preview |
| --- | --- | --- | --- |
| 1 | First run | What would you like to build? Idea or existing project; sample project; planning cost stated first | [html](previews/owner-ui-v2/01-first-run.html) · [png](previews/owner-ui-v2/01-first-run.png) |
| 2 | Home | One line "since your last visit", the decision first, projects with one sentence each | [html](previews/owner-ui-v2/02-home.html) · [png](previews/owner-ui-v2/02-home.png) |
| 3 | Overview | Current goal, the Built / Checked / Available to users strip, next result, budget, release mode | [html](previews/owner-ui-v2/03-overview.html) · [png](previews/owner-ui-v2/03-overview.png) |
| 4 | Plan | Now / Next / Later; what users will be able to do; done-when criteria with check method; agreed boundaries; Start work | [html](previews/owner-ui-v2/04-plan.html) · [png](previews/owner-ui-v2/04-plan.png) |
| 5 | Decision | Options with consequences, suggestion with reason, what continues, if unanswered, own answer, "this did not need me" | [html](previews/owner-ui-v2/05-decision.html) · [png](previews/owner-ui-v2/05-decision.png) |
| 6 | Review | Preview next to "what we checked", "not checked" with reason, where your eyes matter, checker's opinion, Request changes, Accept result | [html](previews/owner-ui-v2/06-review.html) · [png](previews/owner-ui-v2/06-review.png) |
| 7 | Releases | What changes for users, destination, checks, what can and cannot be restored, Publish | [html](previews/owner-ui-v2/07-releases.html) · [png](previews/owner-ui-v2/07-releases.png) |
| 8 | Knowledge | Product facts with provenance, materials, history, the project assistant | [html](previews/owner-ui-v2/08-knowledge.html) · [png](previews/owner-ui-v2/08-knowledge.png) |
| 9 | Project settings | How work runs, release, budget, ask-before-changing areas, notes for the AI, where work happens | [html](previews/owner-ui-v2/09-project-settings.html) · [png](previews/owner-ui-v2/09-project-settings.png) |
| 10 | Settings | Connections with limits, usage by source with unknown kept unknown, alert rules and quiet hours | [html](previews/owner-ui-v2/10-settings.html) · [png](previews/owner-ui-v2/10-settings.png) |
| 11 | States | Ten off-plan situations, each with a message and an action | [html](previews/owner-ui-v2/11-states.html) · [png](previews/owner-ui-v2/11-states.png) |
| 12–13 | Phone | Home and a decision; high-risk decisions are deferred to the computer | [home](previews/owner-ui-v2/12-phone-home.png) · [decision](previews/owner-ui-v2/13-phone-decision.png) |

![Overview](previews/owner-ui-v2/03-overview.png)

![Review](previews/owner-ui-v2/06-review.png)

## 7. Backend coverage today (observed)

| Screen | Served today | Partly | Missing |
| --- | --- | --- | --- |
| First run | Project preflight and connect (`/api/projects/preflight`, `/connect`) | Plan from a description (`/api/work/requests` → `work_drafts`) only for a connected project; a brief only as a path inside it | Idea without a project; sample project; planning-cost estimate |
| Home | Owner items (`ownerView`); project state sentence (`projectsView`) | Recent events, but last-seen is per browser and accepted, limit waits and resumes are not in the summary | Pause all; "Live" (release off) |
| Overview | Goal (`envelope.outcome`), state sentence, result ladder up to Merged | Goal budget (`campaignBudget`), no project budget; pause per goal only | "Available to users" stays unknown while release is off |
| Plan | Goal limits; draft approval (`/api/work/approve`) | Steps with checks and acceptance strings; file scopes instead of included/later; draft versions without a diff | Horizon and priority; editing a plan in the UI; an estimate or an explicit "no estimate" |
| Decision | Blockers with classes and reminders (`owner-intervention.mjs`) | Answer only via recheck with a fixed note or a step instruction; acknowledge without an HTTP route | Options, consequences, suggestion, unanswered policy, "did not need me" |
| Review | Checked commit and time; repair rounds | Verifier checks and findings exist, only counts are served; local Apply (`/api/work/apply`) | Preview and screenshots; where your eyes matter; request changes on a finished step; accept for GitHub results |
| Releases | Release states with honest unknown (`RELEASE_STATES`) | Destination, post-release check and rollback built, switched off | Publish action; user-facing change text; restore scope |
| Knowledge | — | Journal and the last 80 activity entries; coordinator messages not bound to a project | Facts with provenance |
| Project settings | Folder, worktrees, relocate | Release modes narrow only; `denyWrites` per plan; instructions per step | Standing protected areas, standing notes, project budget |
| Settings | Accounts with limit state (`/api/accounts`); supervisor and worker health | AI cost only, no period over HTTP | Hosting and subscription cost categories; notification channels and rules (`owner_notifications` has a no-op transport) |
| States | Limit waits, repair limits, pause and cancel, unknown after restart | Computer offline is visible only locally; outside changes are spread over several mechanisms | — |
| Phone | — | — | Remote access with sign-in; push with answer buttons |

### Built but switched off

| Capability | Opens | Switch |
| --- | --- | --- |
| Plan and do | First run → Plan → Start work | `coordinator.intake` |
| Project connection from the dashboard | First run: choose a folder, connect GitHub | `projectConnection.enabled` |
| Plan approvals as records | Plan versions, decision history | `approvals.required` |
| Release | Releases, third rung of the strip | REL11 |
| Programs and waves | Next and Later starting by themselves | PROG5 |
| Plan amendments | New plan version on a scope change | table exists, writer in E3 |

Local Approve and Apply fail closed until the caller check gets a process lookup (`APPROVAL_UNCHECKED`), and Resume and Approve refuse while the running code is not merged (`RUNTIME_NOT_MERGED`, AW-005).

### First version on today's backend

Without backend work, these parts can be shown truthfully: Home (decisions as blocker text with Check again and Send guidance; projects; recent events), Overview (goal, state, Built and Checked, "Not published: release is off", goal budget, pause goal), Review (version, check summary, rounds, Apply for local projects, pull request link for GitHub), Plan read-only, States, Settings → Connections. Everything else is hidden or marked as not yet available; nothing unbuilt is shown as working.

## 8. Data contract for the new UI (planned)

A view layer beside `/api/state`, one view per screen, built server-side from existing tables, returning only allowlisted safe fields and a version for conflict checks. The current dashboard keeps working until the switch.

**Reads**

| Request | Screen | Built from | New in the store |
| --- | --- | --- | --- |
| `GET /api/v2/home` | Home, phone | `ownerView`, `projectsView`, `journal` | server-side last-seen marker |
| `GET /api/v2/projects/:id` | Overview | `campaigns`, `tasks`, `releaseLadder`, `campaignBudget` | project budget |
| `GET /api/v2/projects/:id/plan` | Plan | `envelope`, `work_drafts` | horizon and priority; criterion = {text, check method}; included / later; estimate |
| `GET /api/v2/decisions[/:id]` | Needs you | `blockers` | decision record: options, consequences, suggestion and reason, what continues, unanswered policy |
| `GET /api/v2/results/:id` | Review | `tasks.verification`, `operations.outcome` | criterion → check → evidence; safe verdict summary; eyes-on items from the verifier schema; preview references |
| `GET /api/v2/projects/:id/releases` | Releases | `releases`, `release_locks` | user-facing change, restore scope |
| `GET /api/v2/projects/:id/knowledge` | Knowledge | `journal`, approvals, blocker resolutions | facts with provenance |
| `GET /api/v2/projects/:id/settings` | Project settings | `projects`, `project_overlays` | protected areas, notes, release rule |
| `GET /api/v2/settings` | Settings | accounts, `costByUnit`, liveness | cost categories, alert rules |
| `GET /api/v2/events?since&project&type&cursor` | Home, Knowledge | `journal` | typed events for accepted, waiting, resumed |

**Actions** (POST with the CSRF token, version binding and a request ID, as today)

| Action | Effect | Builds on |
| --- | --- | --- |
| `decisions/:id/answer` {option or text} | Records the answer, clears the blocker, resumes the right step | recheck, instruct, `blockers` |
| `decisions/:id/snooze`, `/not-needed` | Remind later; "did not need me" feedback | `blockerAcknowledge` |
| `goals`, `goals/:id/plan`, `goals/:id/start`, `goals/:id/horizon` | New goal, new plan version, start, move between Now / Next / Later | `/api/work/requests`, `/approve` |
| `results/:id/accept` | Local: apply; GitHub: merge under the merge gate | `/api/work/apply`, `merge.mjs` |
| `results/:id/request-changes` {feedback, anchor} | Reopen repair in the same goal with the feedback | new |
| `pause` {all, project, goal}, `resume` | Pause with stopping vs stopped per goal | `/api/commands`, STOP |
| `releases/:id/publish` | Manual release of a checked version | `release/*` after REL11 |
| `projects/:id/settings`, `knowledge` | Standing rules; product facts | new |

The AI's own words (suggestion, verdict summary, eyes-on items) are served only as fields of a validated worker output schema, never as raw worker text.

## 9. Work packages

Each package is one or more reviewable PRs. The first four give the full daily loop on the computer: goal → plan → decision → acceptance.

| # | Package | Brings to life | Depends on |
| --- | --- | --- | --- |
| WP1 | `/api/v2` view layer over existing data; typed event feed with a server-side last-seen marker; pause for all / project / goal | Home, Overview, States, Settings → Connections | — |
| WP2 | Structured decisions: record, answer that resumes the step, snooze, "did not need me"; builder and verifier schemas return options and a suggestion | Needs you, the Home card | WP1 |
| WP3 | Plan model: horizon and priority, criteria with check method, included / later, estimate or "no estimate"; draft editing and version diff; enable Plan and do and project connection | First run, Plan, re-approval on scope change | WP1 |
| WP4 | Acceptance: criterion → check → evidence; safe verdict summary; eyes-on items in the verifier schema; request changes on a finished step; accept for GitHub results through the merge gate | Review | WP1, WP3 |
| WP5 | Standing project settings: protected areas, notes for the AI, project and monthly budget | Project settings; "do not start what the budget cannot cover" | WP1 |
| WP6 | Notification delivery replacing the no-op transport, quiet hours, alert rules, answer buttons | Settings → Alerts | WP2 |
| WP7 | Preview of a checked version: run it locally and capture screenshots | Review: try, desktop / phone | WP4 |
| WP8 | Knowledge facts with provenance; sample project on synthetic data; planning-cost estimate; cost categories | Knowledge, First run, Usage | WP3 |
| WP9 | Manual release and its content: user-facing change, restore scope, post-release check (after REL11) | Releases, the third rung | WP4, owner decision |
| WP10 | Remote access with sign-in and phone push | Phone | WP1, WP2, WP6, owner decision |

Tests follow [AGENTS.md](../../AGENTS.md#validation): only product-critical behaviour, for example an answer that resumes the wrong step, an accept that merges an unchecked commit, a pause that does not stop new runs, or a view that leaks worker text or paths.

## 10. Owner-reserved questions

- **Remote access (WP10).** The dashboard binds loopback only and its token is readable by any local process (AW-003). A phone needs a separately reviewed sign-in, a paired relay or a trusted device. Which one?
- **Release (WP9).** Which destinations may a manual Publish reach, per project (AW-010)?
- **GitHub reads (WP4).** The dashboard makes no GitHub API calls. Should accept and request-changes for GitHub results go through the supervisor, or may the dashboard read review state?
- **Words.** This proposal says "Needs you" and "Accept result"; OWNER_WORKSPACE.md says "Needs me" and reserves "Accepted" for recorded acceptance. Keep, rename, or adopt?

WP1 to WP8 can start without these answers.
