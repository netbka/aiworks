# Home v2: goals, steps and what landed

**Privacy boundary:** this is a design, not an installation record. Every project, goal, step, amount and time below is fictional.

**Status:** the data (part 1) is built in source: `GET /api/v2/home` and the `home` part of `/api/state` carry it. The screen (part 2) is built in source: `public/home.mjs` and `homeScreen()`, with answer changes (2.1) and goal links (2.2). Its check (part 3) was done on 11 November 2026.

Home answers three questions in the owner's words, in this order: does anything need me, what is being made right now, and what was finished today. It never shows reference numbers, commit hashes, decision codes, step ids, file names, version names or internal state names, and it does not explain how AIWorks works.

## 1. Part one: the Home data

Home gains five fields. The older fields stay, so the current screen keeps working until part 2 replaces it.

### 1.1 `goals`: every running or paused goal

Each goal is one entry:

| Field | Meaning |
| --- | --- |
| `project` | The project's name. |
| `title` | A short title, at most 60 characters (1.2). |
| `now` | `Now: <step>` while a step is being built or checked, `Next: <step>` when none is or while AIWorks is stopped, `Waiting for your answer` when the goal asks the owner something, or null when nothing is left to start. |
| `done`, `total`, `dropped` | Steps finished, all steps, steps dropped. |
| `segments` | One entry per step, in plan order: `done`, `now`, `asks`, `todo` or `dropped`. The screen draws them as a strip. |
| `state` | `Asks you`, `Building`, `Checking`, `Waiting`, `Queued` or `Paused`. |
| `link` | Where the goal's title leads: `{ project, goal }`, the project's address key and the goal's own id (2.2). Never shown as words; null when the project is not known. |

Order: goals that ask the owner something first, then those being built, checked or waiting, then queued, then paused. Within a group, the order they were started.

A goal asks the owner something only when the owner-action list counts it (1.3). While AIWorks is stopped on this computer (the header's Stopped), nothing is built or checked: every goal that is neither paused nor asking is `Waiting`. Otherwise it is `Checking` when one of its current steps is with the independent checker, `Building` when a step is being made, and `Queued` otherwise. The Home data carries `stopped: true` then.

Example (fictional):

```json
{ "project": "bakery", "title": "Online cake orders", "now": "Now: Order email",
  "done": 1, "total": 3, "dropped": 0, "segments": ["done", "now", "todo"], "state": "Building" }
```

### 1.2 Goal titles

A plan may give its goal a `title`: one plain line, at most 60 characters. The planning and coordinator instructions ask for one. A title that is not one plain line of at most 60 characters is left out of a draft, never refused.

Without a title, Home makes one from the goal's purpose, then its outcome, then its first step:

- a leading label before ":" goes when it holds a code, wave or step name ("Wave 3: Share garden photos" becomes "Share garden photos");
- reference numbers ("#12", "bakery#12"), parentheses with what they hold, links, commit hashes, ids, codes and version names go everywhere, with any small word they leave hanging ("for", "in");
- the rest is cut at 60 characters on a word, without a closing full stop, and starts with a capital.

Step titles in `now` and `landed` are cleaned the same way.

### 1.3 `needs`: one count

`needs.count` is the number of items only the owner can answer. It is the same number on the Home navigation badge and in the Home headline, because both read the same list. Needs you is not a separate screen: its address opens Home. A result AIWorks merged itself is landed (1.4), never "to review". Decisions AIWorks answers itself and steps it finishes or ends itself are listed apart and not counted.

### 1.4 `landed`: one line per finished step

One entry per step whose checked version was merged in the last 24 hours: `{ title, project, at }`, newest first, at most 20, with `total` beside them. A step that was built, checked and merged produced three events; it is still one line. A step counts only when the merge record names exactly the version the independent check passed.

```json
{ "total": 2, "entries": [
  { "title": "Order form", "project": "bakery", "at": 1793530800000 },
  { "title": "Search box", "project": "library", "at": 1793520000000 } ] }
```

### 1.5 `quiet`: projects with nothing running

A project with no running or paused goal: `{ name, state }`, where state is `Done` when its latest goal finished and `Stopped` when it was cancelled. A project that never had a goal is not listed here; the project list still shows it.

### 1.6 `spentToday`

What the runs of the running and paused goals that finished today (from local midnight) reported: `{ usd, unreportedRuns }`. `usd` is null, never 0, when no run reported a cost, and runs that reported none are counted apart.

### 1.7 Acceptance of part one

- The Home data, read on a store with three goals, carries `goals`, `landed`, `needs`, `quiet` and `spentToday` as above; no goal title has a reference number, hash, id or code, and none is longer than 60 characters.
- Three events of one step (built, checked, merged) are one landed entry.
- The needs count equals the owner-action items Home lists; a result AIWorks merged is not counted.
- This document uses fictional examples only.

## 2. Part two: the Home screen

Home is one centred column, at most 1040 px wide. Top to bottom:

1. A headline: "Nothing needs you.", "One question for you." or "N things need you.", with one grey line such as "3 goals are moving in bakery. 14 changes landed since yesterday." (`needs.count`, `goals`, `landed.total`). The line counts the goals that are not paused. While AIWorks is stopped (`stopped`) they are not moving: the line says "3 goals are waiting in bakery. Nothing runs until AIWorks starts again."
2. Only when something waits: one card per item, the question as its heading. A choice shows its two to four options as selectable cards with their effect and "Suggested" on the suggestion, one Answer button and what happens without an answer. Anything else shows its question and a link to where it is settled.
3. In progress: one row per goal (`goals`) with its title, the `now` line, a strip of its segments, "1 of 3 done" and its state; the spend of `spentToday.usd` in the block head when known.
4. Decided for you: one line per decision with the answer in force in bold and a Change control (2.1); hidden when empty.
5. Landed since yesterday: at most five lines from `landed.entries`, the rest behind "All N" when all entries are available. When `total` exceeds the available entries, the button says "Latest N" and a note states how many of the total changes are shown. Expanding keeps the data's 20-entry bound; "Fewer" returns to five.
6. Quiet: one line of project links from `quiet`.

The header carries the logo, the navigation, one word for the work (Working, Idle, Paused or Stopped) and Pause all. Idle is said when no work needs AIWorks, as Settings › Connections says. It shows no version, computer name, connection or refresh text; while the page cannot reach the dashboard that word is "Offline" and the controls are off.

Navigation is Home, Projects and Settings. Needs you is not a screen: its address opens Home, and the count on the Home item is `needs.count`, with "checking" beside it while a result's merge is still being checked. When nothing needs the owner but such a check is unresolved, the headline says "Nothing needs you, but a result is still being checked." rather than claiming calm; the count stays the owner's own actions. AIWorks's own problems, work stopped until restarted and routine work are in Settings, in one folded section "AIWorks itself"; Home shows one grey line "AIWorks has N problems of its own" linking there only when such a problem stops work, and it is never in the count.

Words come from the data above as text, never as markup; the screen adds no codes, numbers or explanations of how AIWorks works.

### 2.1 Changing an answer

A decided answer can be changed from Home: Change opens the decision's recorded options with the answer in force chosen, and `POST /api/v2/decisions/change` records the new one. Only the owner's own browser session may send it (the same caller check as answering); a program AIWorks started is refused and nothing is written. The request binds the goal's version, authorization and scope, the step's version, the decision and the exact answer the owner saw.

- **History.** The first answer, with who gave it (AIWorks under AW-017, or the owner), and every change stay in the journal. A change is a new record that names the owner's request, the digest of any words and the answer it replaces; nothing earlier is edited.
- **Stale or replayed.** A change bound to an answer that is no longer in force, a step that moved on, or a second change of the same answer is refused with nothing written. A retry of the same request is acknowledged, never recorded twice.
- **Step still being made.** Its later runs, builders and checkers alike, get the new answer in place of the earlier one, under the same authority and scope; the earlier answer is never delivered again. Committed work, runs and checks are kept: the next run builds on them and never rewrites, resets or undoes them, and never repeats an action that published, disclosed, deployed or spent something.
- **A run already worked under an earlier answer** (one started at or after the decision's first answer, or is still open). The new guidance goes to later runs as above, and one follow-up item asks for the step's result to be checked against the new answer, because its only later run may be a check that passes the earlier work.
- **Step that already used the answer** (checked, merged, finished or ended). The step is not reopened and its result is not rewritten. One follow-up item records the new answer, for new, bounded work planned under the existing authority. The new guidance is recorded too, under the same authority and scope, so a step reopened later (requested changes, an integration repair) follows the owner's latest answer.
- **Words.** The confirmation says which of the three happened; it never says later runs follow the new answer when work already used the earlier one without also naming the follow-up.
- **Never wider.** The new option is one of the options recorded with the decision; a change clears no stop, starts no run, raises no limit and widens no packet. A text an AI worker or a GitHub comment posts is never an answer: only the supervisor writes answer records, from the owner's checked session or under AW-017.

An answer the owner gave in their own words, without recorded options, is not changed here.

### 2.2 Goal links

A goal's title on Home opens that goal in its own project, `#/p/<project>/goal/<goal>`, from the goal's `link`. The page shows only that goal, and only when it belongs to that project; otherwise it says the goal is not recorded there and links to the project's work.

Acceptance: the screen reads only the fields of part one, the headline and the badge show the same number, and every visible word is plain English for a person.

## 3. Part three: the check of the whole (done)

An independent check of the final version runs the complete local check and the public-scope check, and reports the real tally and the exact version it checked. It looks at Home at desktop and phone width on the synthetic fixtures and confirms that nothing on it is written for an engineer.

Done on 11 November 2026. The independent check found engineer words that could reach Home, and they were rewritten:
- the notice after Accept named the merge gate;
- a sign-in stop sent the owner to Diagnostics instead of saying to sign in again;
- a missing store and a busy refusal named the supervisor;
- a GitHub link was called a pull request;
- a card could fall back to a bare step id.

The Change control on Decided for you now lines up with the other links and has a full-size tap target. The words of the Review form ("repair round", "criterion") are outside Home and are not part of this check.
