# UI glossary

Status: proposal for the owner's approval, 2026-10-25. Nothing here is accepted until the owner says so; marked choices are open.

One concept, one word, on every owner screen, in every button, badge, heading, accessible label and notification. The words follow GitHub and Linear, the two products the owner chose as references, so that someone who uses them recognizes each object without being taught. Counts of current use come from [UI_INVENTORY.md](UI_INVENTORY.md).

**How to use this file.** Before writing any owner-facing text, look the concept up here. Use the word in the *Use* column. Never use a word from *Do not use* on screen; it may stay in code and in the supervisor's records. A new concept gets a row here before it gets a screen.

## 1. Objects

| Concept | Use | Do not use on screen | GitHub / Linear equivalent | Notes |
| --- | --- | --- | --- | --- |
| A repository or folder AIWorks works on | **Project** | repository (except in "GitHub repository" when connecting), repo | GitHub repository | Already consistent. |
| What the owner wants to be true, broken into steps | **Goal** | work (as a countable noun: "this work", "a piece of work"), campaign, track | Linear project, GitHub milestone with a tracking issue | Today: goal 35, work 146, campaign 3, track 1 on screen. "Work" stays only as the activity ("work continues by itself"). |
| One unit a builder does and a checker checks | **Step** | task | Linear issue, GitHub issue | Today: step 244, task 12 on screen. |
| What a step delivers | **Result** | checked version (as a name), PR as the primary label | GitHub pull request, or an issue comment for a report | A result is either a code change (shown with "View pull request ↗") or a report. The number is secondary metadata. |
| The ordered set of goals and steps the owner approved | **Plan** | roadmap (reserved for AIWorks's own version roadmap in Settings) | Linear project milestones, GitHub project board | Already consistent. |
| Things only the owner can settle | **Needs you** | Needs me, Resolve in, waiting for your review | Linear Inbox, GitHub notifications | Decided 2026-10-21. One place, one count. |
| A conversation with AIWorks | **Chat** | message (as the screen name), coordinator, planning assistant | — | The other side of a chat is named **AIWorks**. |
| A local item without GitHub | **Work item** | — | Linear issue | Open: whether a work item is simply a step of a project without GitHub. If so it should be called a step. |
| A fact AIWorks keeps about a project | **Knowledge** | material, fact (as a section name) | GitHub wiki, Linear docs | — |

## 2. People and roles

| Concept | Use | Do not use on screen | Equivalent |
| --- | --- | --- | --- |
| The person running AIWorks | **you** (in text), **owner** (in documentation only) | the owner, me | — |
| The AI session that writes a step | **Builder** | agent, worker (alone), implementer | GitHub assignee / author |
| The fresh AI session that checks a result | **Checker** | verifier, independent checker (as a name) | GitHub reviewer, required check |
| Either of the two, or the CLI behind them | **AI worker** (with the product in brackets: "Builder (Claude)") | agent | — |

## 3. Actions

| Concept | Use | Do not use | Equivalent |
| --- | --- | --- | --- |
| Approve a result as it is | **Accept** | Approve (reserved for plans), Mark done | GitHub "Approve" |
| Send a result back with what should change | **Request changes** | Not right, Send back | GitHub "Request changes" |
| Approve a plan so work can start | **Approve plan** / **Approve and start** | Confirm, Register | — |
| Start planning something new | **New goal** | Plan work, Start work, Plan different work…, Ask for a plan | Linear "New project", GitHub "New issue" |
| Plan a stopped or cancelled goal again | **Plan again** | Plan this work again… | GitHub "Reopen" |
| Run a stopped step once more, with or without guidance | **Try again** | Check again, Retry, Recheck | GitHub Actions "Re-run" |
| Halt reversibly | **Pause** / **Resume** | Stop (as a button), Continue | — |
| Halt permanently | **Cancel** | Stop, Abort | GitHub Actions "Cancel run", Linear "Canceled" |
| Give a builder or checker instructions for their next run | **Send guidance** | Send instructions, Send answer (except as the submit of a decision) | Pull request comment |
| Answer a question a builder asked | **Answer** | Decide, Send answer | — |
| Snooze an item on Needs you | **Snooze** | Remind me later | Linear "Snooze" |

"Check" alone is reserved for what the checker does. That is the reason "Check again" becomes "Try again".

## 4. Step statuses

One ordered set, like Linear's workflow states. Every step is in exactly one; every list, card, badge and count uses these words and colors and nothing else. The color family is the badge's; the words always accompany the color.

| Status | Meaning | Color family | Replaces today |
| --- | --- | --- | --- |
| **Planned** | In an approved plan, not begun | gray | Not started, In an approved plan, Waiting |
| **Building** | A builder is working on it | blue | Being built, Working on… |
| **Checking** | A checker is working on it | blue | Being checked, Checking… |
| **Needs you** | Waiting on the owner: a question, a result to review, or a failure to look at. The card says which | amber | Needs you, Review ready, Decision needed, Needs setup, Stopped; will not retry by itself, Changes requested · not being made |
| **Accepted** | Passed the check and accepted, not merged yet | green outline | Passed the check, Passed, Checked on this computer · not merged yet |
| **Merging** | AIWorks is bringing an accepted result into the main branch | blue | Published, merge not seen yet (when AIWorks merges) |
| **Done** | Merged, or the report posted | green | Merged, Report posted |
| **Blocked** | Waiting for another step or for a limit to reset; AIWorks handles it | gray with icon | Blocked, Waiting for merges |
| **Paused** | The owner paused it | gray | paused |
| **Canceled** | The owner cancelled it | gray, struck | cancelled, stopped |
| **Unknown** | AIWorks cannot tell yet | gray, dashed outline, never amber | Result not known, Not checked, Not recorded |

Open decisions for the owner:

- **A**. "Possibly stuck" is a warning on a running step, not a status of its own. Proposal: keep the status (Building or Checking) and add a warning line "No progress for 26 min". Linear does the same with SLA warnings.
- **B**. "Accepted" when the owner merges by hand versus "Merging" when AIWorks merges. Proposal: as in the table; a project without automatic merging stays Accepted until the owner merges.
- **C**. Whether a published-but-unchecked result needs its own status, or is Needs you with the reason "no check on record". Proposal: Needs you.

## 5. Goal and project statuses

Derived from their steps, never computed separately per screen. A goal or project shows the most urgent status among its steps in this order: Needs you, Building/Checking, Blocked, Accepted, Planned, Done; Paused and Canceled only when the owner set them on the goal itself. Home, Projects and the project's Overview must show the same word for the same project at the same moment.

## 6. Attributes are not statuses

Labels such as Default, Economy, Fast, Deep thinking, Security-critical or Core role describe a model or an account. They use a neutral label style (Linear labels, GitHub topics), never a status color, so that "Security-critical" does not read as a warning.

## 7. Words that stay internal

These may appear in code, records and documentation, never on owner screens: campaign, run, packet, lease, worktree, envelope, head, SHA or commit hash, task, verifier, coordinator, supervisor (except in Diagnostics), invalid result, the release codename.

## 8. Writing rules that go with the words

- Sentence case for everything: buttons, titles, badges.
- A button says what happens: verb plus object ("Accept result", "Pause goal"). No arrows in button text.
- A count is a number of objects ("3 steps need you"), never "things".
- Unknown is said as unknown ("Not known yet"), never as zero.
- Pull request and issue numbers appear only as secondary links ending in ↗.
