# Home v2: goals, steps and what landed

**Privacy boundary:** this is a design, not an installation record. Every project, goal, step, amount and time below is fictional.

**Status:** the data (part 1) is built in source: `GET /api/v2/home` and the `home` part of `/api/state` carry it. The screen (part 2) is built in source: `public/home.mjs` and `homeScreen()`. Its check (part 3) is planned.

Home answers three questions in the owner's words, in this order: does anything need me, what is being made right now, and what was finished today. It never shows reference numbers, commit hashes, decision codes, step ids, file names, version names or internal state names, and it does not explain how AIWorks works.

## 1. Part one: the Home data

Home gains five fields. The older fields stay, so the current screen keeps working until part 2 replaces it.

### 1.1 `goals`: every running or paused goal

Each goal is one entry:

| Field | Meaning |
| --- | --- |
| `project` | The project's name. |
| `title` | A short title, at most 60 characters (1.2). |
| `now` | `Now: <step>` while a step is being built or checked, `Next: <step>` when none is, `Waiting for your answer` when the goal asks the owner something, or null when nothing is left to start. |
| `done`, `total`, `dropped` | Steps finished, all steps, steps dropped. |
| `segments` | One entry per step, in plan order: `done`, `now`, `asks`, `todo` or `dropped`. The screen draws them as a strip. |
| `state` | `Asks you`, `Building`, `Checking`, `Queued` or `Paused`. |

Order: goals that ask the owner something first, then those being built or checked, then queued, then paused. Within a group, the order they were started.

A goal asks the owner something only when the owner-action list counts it (1.3). It is `Checking` when one of its current steps is with the independent checker, `Building` when a step is being made, and `Queued` otherwise.

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

1. A headline: "Nothing needs you.", "One question for you." or "N things need you.", with one grey line such as "3 goals are moving in bakery. 14 changes landed since yesterday." (`needs.count`, `goals`, `landed.total`).
2. Only when something waits: one card per item, the question as its heading. A choice shows its two to four options as selectable cards with their effect and "Suggested" on the suggestion, one Answer button and what happens without an answer. Anything else shows its question and a link to where it is settled.
3. In progress: one row per goal (`goals`) with its title, the `now` line, a strip of its segments, "1 of 3 done" and its state; the spend of `spentToday.usd` in the block head when known.
4. Decided for you: one line per decision with the chosen answer in bold and a Change link; hidden when empty.
5. Landed since yesterday: at most five lines from `landed.entries`, the rest behind "All N".
6. Quiet: one line of project links from `quiet`.

The header carries the logo, the navigation, one word for the work (Working, Paused or Stopped) and Pause all. It shows no version, computer name, connection or refresh text; while the page cannot reach the dashboard that word is "Offline" and the controls are off.

Navigation is Home, Projects and Settings. Needs you is not a screen: its address opens Home, and the count on the Home item is `needs.count`, with "checking" beside it while a result's merge is still being checked. When nothing needs the owner but such a check is unresolved, the headline says "Nothing needs you, but a result is still being checked." rather than claiming calm; the count stays the owner's own actions. AIWorks's own problems, work stopped until restarted and routine work are in Settings, in one folded section "AIWorks itself"; Home shows one grey line "AIWorks has N problems of its own" linking there only when such a problem stops work, and it is never in the count.

Words come from the data above as text, never as markup; the screen adds no codes, numbers or explanations of how AIWorks works. Not built yet: Undo after an answer (no command reverses an answer), and the goal link goes to the goal's project because the data names no goal address.

Acceptance: the screen reads only the fields of part one, the headline and the badge show the same number, and every visible word is plain English for a person.

## 3. Part three: the check of the whole (planned)

An independent check of the final version runs the complete local check and the public-scope check, and reports the real tally and the exact version it checked. It looks at Home at desktop and phone width on the synthetic fixtures and confirms that nothing on it is written for an engineer.
