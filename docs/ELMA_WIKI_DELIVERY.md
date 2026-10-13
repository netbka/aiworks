# ELMA Wiki delivery on this PC

Owner assignment: 2026-10-13, use AIWorks to plan and execute delivery of `C:/git/elma_wiki` / `netbka/elma_wiki`, watch progress and prepare AIWorks fix PRs when its machinery stalls. This does not widen worker tool isolation or authorize live ELMA operations.

## Verified checkpoint (2026-10-13)

Read-only runtime status from `C:/git/aiworks/.local/runtime` and data `C:/git/aiworks/.local/supervisor` confirms:

- `elma-wiki-planning` is finished. [PLAN-01](https://github.com/netbka/elma_wiki/issues/91#issuecomment-6086757327) passed independent report verification.
- `elma-wiki-execution` is cancelled and superseded. P1–P5 are done; their integration is recorded in the successor declaration. Do not register duplicate implementation work.
- `elma-wiki-execution-2` has a live controller at revision `2c6adce29e8778c48863e52e7a81f0f5aa7c840e`, two charged runs, no open operation, P6 done and P7 pending on P6 integration.
- [P6 PR #113](https://github.com/netbka/elma_wiki/pull/113) is open, mergeable and has successful recorded checks. Its head equals the store's independently verified head `2e994777e14a48698ec9027df374ba366c1bf49e`. There is no GitHub approval review; the independent verification is recorded in the supervisor-generated PR body and store. This is Wiki-side acceptance, not native validation.
- The controller already polls the integration dependency. Rechecking or launching another campaign cannot replace the missing merge. The separate production-updater PR #114 is outside this delivery's critical path.

This is a point-in-time observation. Refresh runtime status and GitHub metadata before using it; a live lease is not proof that a worker is running. Native contract, live target and business acceptance are not verified here.

## Execution order

1. Wiki's integration lane resolves PR #113 under Wiki's merge gate. Agent work in AIWorks cannot write another project; the supervisor's registered-campaign exception publishes PRs but does not merge them. Keep the existing campaign running while this integration is pending.
2. Its existing `requiresMergedDependencies` gate detects the verified P6 commit in freshly fetched main and starts P7: frozen composed candidate, stale-input guards, reservations, recovery and synthetic delivery integration. Independently verify the resulting exact head and integrate through Wiki's lane.
3. P8 acquires exact physical/native and affected business-flow evidence. Missing native contract or safe supervisor capability is an evidence gap; selecting a live Target/candidate or performing an import still requires the destination-specific authority described in the declaration. Do not spend repeated worker runs on unchanged missing evidence.
4. P9 follows actual Contracts acceptance, addressing destination promotion, recovery and remaining release scopes. Report publication alone does not finish these product gates.

Reuse the accepted plan and completed slices. Sequence integration and dependent work; no increased concurrency grant is implied. Keep #59/#41 human work deferred and #19 provider execution disabled. No unmeasured speed or cost saving is claimed.

## Watch progress

The controller's existing integration polling automatically resumes P7 after the dependency gate passes. For a separate read-only observation stream:

```powershell
node scripts/supervisor/watch-campaign.mjs --checkout C:/git/aiworks/.local/runtime --data C:/git/aiworks/.local/supervisor --campaign elma-wiki-execution-2 --output C:/git/aiworks/.local/campaigns/elma-wiki-execution-2-watch.json
```

`--once` records one observation and exits. The default interval is one minute. The latest snapshot records observation time on every poll; the adjacent `.changes.jsonl` records state changes. Retry timestamps do not create false progress events. Neither file contains worker reports, raw errors, credentials or private customer content. `status-unavailable` is an observation failure, not proof that a controller stopped.

The watcher never changes campaign state or creates PRs automatically. When delivery stops advancing, inspect the latest snapshot and exact failing gate. Recover under existing authority. For an AIWorks defect, deduplicate against existing issues, reproduce it, prepare a focused fix PR with required validation and exact-head independent review, and keep unrelated work moving. For an integration or native evidence dependency, identify its owning lane instead of weakening the gate. Runtime deployment remains a separate procedure; a fix PR is not a live repair.
