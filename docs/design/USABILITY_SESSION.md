# Blind usability session with a person (script and success measures)

**Status: prepared, not run.** No person has used AIWorks in a session under this script. The [owner journey](OWNER_JOURNEY_ACCEPTANCE.md) is a scripted check by an AI implementer, not a substitute. Results of a session are installation data: notes, recordings, timings and the participant's identity stay with the facilitator and the local work list, never in this repository.

The question the session answers is the constitution's: can an owner who did not build AIWorks understand progress and blockers in under a minute, and do their own work (connect, plan, decide, try, apply, undo) without knowing how the tool works inside? It replaces the AI reviewer of [OWNER_WORKSPACE §13](OWNER_WORKSPACE.md#13-blind-review-protocol-ux-002-pass-a) with a person, on the current local-project flow.

## Who and how long

- Three to five participants, one at a time, about 45 minutes each. Each builds or runs small apps, uses AI tools, and has never seen AIWorks, its code or its documents.
- One facilitator, who prepares the runtime and reads the script; one note taker if possible. The facilitator owns the participant's consent for any notes or screen recording.

## Preparing the disposable runtime (the participant never sees this)

Windows with Chrome, a checkout at the revision under test, `npm install` done. The folder must be new, outside every Git repository and outside the home folder.

```
node scripts/supervisor/owner-journey.mjs setup <new-folder>
```

Before starting, overwrite `<new-folder>/fake/scenario.json` with the synthetic worker's script for the session: planner on, then a first goal that builds, a second that stops for the owner and builds once answered.

```
{ "intake": true, "implement": ["commit-page", "owner", "commit-page", "commit-page", "commit-page"] }
```

```
node scripts/supervisor/owner-journey.mjs start <new-folder>
```

It prints the dashboard's `url` on a free loopback port. Open that address in an ordinary browser window at desktop size. Write the two project folders, `<new-folder>/owner/notes` and `<new-folder>/owner/site`, on a card for the participant. Check that Home says *No projects yet*. Everything is synthetic: fictional projects, a synthetic AI worker that makes no model or network call, no account, no recipient. Never point a session at a live installation's data folder or dashboard.

Afterwards: `node scripts/supervisor/owner-journey.mjs stop <new-folder>`, then delete the folder once the notes are copied out.

## Script

Read aloud, word for word:

> Thank you for helping. We are testing the software, not you; nothing you do is wrong. Imagine you build a few small apps on your own computer, and you have a tool where AI workers make changes to them for you. Please think aloud: say what you are looking for and what you expect. I will mostly stay quiet. When you think a task is done, say "done". If you would give up at home, say so; that is useful too.

Then give each task as written, one at a time. Do not name a screen, button or tab. If the participant asks a question, answer with "What would you do if I were not here?" Give a hint only after two minutes without progress or on request, from general to specific (*Where would you look for that?*, then naming the area of the screen), and record each hint.

| # | Task as read to the participant | Hidden success check |
| --- | --- | --- |
| U1 | "You just installed this. Connect your notes project so the tool can work on it." (the card) | Adds the folder and confirms its rules, without a dead end. |
| U2 | "Ask it to make the notes page greet visitors. Nothing should change in your own folder until you say so." | Gets a plan, starts exactly it, and can say the folder is unchanged so far. |
| U3 | "Before you accept anything, see how the result looks on a phone." | Finds Try this version and the phone view (or screenshots). |
| U4 | "Put the result into your folder. Then change your mind and take it back." | Apply, then Undo apply; can say the folder is back as it was. |
| U5 | "Ask for one more change: a footer on the page." Wait until the dashboard shows something waiting. | Starts the second plan. |
| U6 | "Without help: what is going on, and does anything need you?" Timed from this sentence to the answer. | Names the waiting decision and its project in under a minute. |
| U7 | "Deal with it. You want to stay on the free plan." | Finds the decision and answers it; can say the work continues. |
| U8 | "Is the greeting live for visitors on the internet?" | Says it is not released or live, and nothing was published. |
| U9 | "Roughly what has this cost so far?" | Finds a cost and that it covers only reported runs. |
| U10 | Narrow the window to phone width (or use a phone on the same computer) and repeat U6. | Same answer, no sideways scrolling. |

After each task, ask: "On a scale of 1 (very hard) to 7 (very easy), how easy was that?" After the last task, ask three open questions: What was most confusing? What did you expect to find and did not? Would you trust it with a real project, and why or why not?

## What to record per task

- Completed unaided, completed with hints (how many), or not completed.
- Time from the task's first word to "done".
- Wrong turns: a screen opened and left without acting.
- **False beliefs**, stated by the participant: that the folder changed when it did not (or the reverse), that something is live or was sent, that a cost is complete, or that the tool acted without them. Each is a severe finding, whatever the task's outcome.
- The participant's words for what a screen is for, where they differ from what the screen is meant to answer.
- Each finding as a UX-002 §4 record (screen, state, viewport, revision, severity), kept in the local work list.

## Success measures

The session passes for a revision when, across the participants:

- **Under a minute:** U6 answered correctly and unaided in under 60 seconds by every participant, and U10 by at least all but one.
- **No false belief** about the folder, publishing, sending or cost is left uncorrected by the screen itself.
- **Core tasks:** U1, U2, U4 and U7 completed unaided by at least all but one participant, and none of them failed by a majority.
- **Ease:** a median rating of 5 or more for every task; any task with a median below 4 is a finding.
- **No blocker or must finding open** after the facilitator's triage.

A revision that misses a measure gets its findings repaired and a new session; a pass is about that revision only and says nothing about an installed version.
