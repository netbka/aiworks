# Status

As of 2026-10-12. This page is the one place where current status lives. Normative documents state rules, not progress. A PR that changes the status of something listed here updates this page. Live work state stays in GitHub issues and PRs.

## Needs you

- **How should AIWorks reach you when something is blocked?** Until you choose, you see blockers only when you open the dashboard. The choice covers the Telegram bot and where its secret is kept, your chat, the snooze policy and the incident path. The code that records blockers is in place and switched off ([SUPERVISOR.md §10](SUPERVISOR.md#10-owner-intervention-core), [netbka/aiworks#1](https://github.com/netbka/aiworks/issues/1)).
- **One browser check of Dyk is waiting for your go.** It would check in a real browser that Dyk's main signed-in screens look and read right in Russian, English and Hebrew, on desktop and phone. It was declared before the split (`dyk-485-view-acceptance`) and never started. Before it starts, check that the Storybook it opens matches current Dyk main.

Nothing else is blocked on you.

## Where things stand

- **AIWorks is its own product now.** On 2026-10-12 it was split out of Engineering Platform ([AW-007](DECISIONS.md#aw-007---aiworks-is-a-standalone-product-separate-from-engineering-platform)). It runs on HomePc from `D:/Git/aiworks/.local/runtime`.
- **All earlier campaigns are finished.** Every campaign that ran on HomePc before the split finished; one (`dyk-no-manual-edit`) was cancelled. Their pull requests and reports are in GitHub. The supervisor store is fresh, so no campaign is registered yet. The old records are archived ([AW-007](DECISIONS.md#aw-007---aiworks-is-a-standalone-product-separate-from-engineering-platform)).
- **The second PC is unchanged.** HOMELENOVO still runs the old Engineering Platform build with the elma-wiki campaigns. AIWorks does not manage it, and its current state is not observed from here.
- **Project rules come from Engineering Platform.** AIWorks reads the project registry and policies from the governance checkout at `D:/Git/aiworks/.local/governance` ([SUPERVISOR.md §6](SUPERVISOR.md#governance-checkout)).

## Open work

1. **Owner notifications.** The blocker records, deduplication and recheck are built and off by default. No message leaves the machine yet. Next: the notification adapter, after your choice above ([netbka/aiworks#1](https://github.com/netbka/aiworks/issues/1)).
2. **Campaigns run only from merged code and a declaration on main** ([AW-005](DECISIONS.md#aw-005---campaigns-run-only-from-merged-supervisor-code-and-a-declaration-on-main)). Decided, but not enforced yet. The change was written in Engineering Platform and never merged ([PR #139](https://github.com/netbka/engineering-platform-archive/issues/139), archived). It needs porting here.
3. **No two campaigns working on the same repair.** A second campaign must not claim work another campaign already owns. The first slice was written in Engineering Platform and never merged ([PR #126](https://github.com/netbka/engineering-platform-archive/issues/126), draft, archived). It needs porting here ([netbka/aiworks#5](https://github.com/netbka/aiworks/issues/5)).
4. **Rest of the supervisor.** GitHub webhooks, a project release adapter, more than one worker at a time, and install evidence on an approved host ([netbka/aiworks#2](https://github.com/netbka/aiworks/issues/2)).
5. **Dashboard owner view.** Live since 2026-10-11. Still open: the *changes requested*, *deployed* and *accepted* step states, outcomes written by the coordinator, and the full experience review ([netbka/aiworks#4](https://github.com/netbka/aiworks/issues/4)).
6. **Coordinator planning request** from 2026-10-10: review new PRs and issues and plan their execution. Still open ([netbka/aiworks#3](https://github.com/netbka/aiworks/issues/3)).
7. **Browser-worker follow-ups** from the review of the AGY and Claude browser workers ([SUPERVISOR.md §11](SUPERVISOR.md#11-web-acceptance-by-the-agy-browser-worker)). Observed in the code at the split, not fixed:
   - Claude on a web task skips the managed-Claude-configuration check that research mode runs. HomePc had no managed configuration on 2026-10-11.
   - `dyk-485-view-acceptance` declares `permissionMode: "auto"`, which has no effect, because web runs use `dontAsk`.
   - `dyk-485-view-acceptance` has no run or cost cap. That is the default ([AW-002](DECISIONS.md#aw-002---campaigns-have-no-capacity-limits-by-default)); the review listed it as a follow-up.
