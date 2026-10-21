# Adaptive worker concurrency across tasks and projects

**Privacy boundary:** this is a design proposal, not a live installation record. Campaign declarations and approval records stay private under [AW-009](../DECISIONS.md#aw-009---public-commits-contain-no-installation-data). Any proposal to publish declarations through source branches or pull requests is superseded. Merged executable code, explicit owner authorization, scope binding and independent verification remain required.

**Status:** design only. Nothing in this document is built, merged into the runtime or deployed. Refs #9, #5, #14.

**Basis:** design notes; implementation status must be checked against the selected runtime revision.

**Inputs:** [PROJECT_WORKSPACE_PLAN.md §5.2](../PROJECT_WORKSPACE_PLAN.md#52-adaptive-parallelism), #9, #5 scopes A, B and D, [SUPERVISOR.md](../SUPERVISOR.md), [WORKER_CONTEXT_LIFECYCLE.md](../WORKER_CONTEXT_LIFECYCLE.md), [DECISIONS.md](../DECISIONS.md) (AW-001, AW-002, AW-005). governance provider rules apply through [AGENTS.md](../../AGENTS.md) and are linked, not repeated: Owner Intervention, rate limits, Continuation, Agent Operating Model.

## 1. What the owner gets

- **More useful work at once.** Inside one approved work program, steps that do not depend on each other and do not touch the same files run at the same time. Steps that would edit the same files still run one after the other.
- **Several projects move together.** A busy project cannot hold up a quiet one. Each project gets its turn.
- **It starts carefully and speeds up only when that pays off.** A work program starts with one worker. It adds a worker only after a run produced a useful result while other ready work was waiting. It slows down when runs fail, when a provider says "too many requests", or when the computer is short of memory, CPU or disk.
- **One provider limit, one wait.** When a provider account reaches its usage limit, every program using that account waits for the same reset. No program keeps knocking on an exhausted account.
- **Nothing is done twice.** A crash, a restart, a second supervisor instance, an unclear launch or a cancellation never produces a second PR, a second comment or two workers editing the same files.
- **Every waiting step says why.** For example: "Waiting: another step is changing `src/dashboard/` (PR #41 not merged yet)", or "Waiting: Claude usage limit resets at 14:05". The step also shows what happens next without the owner.

What it does **not** do:

- It sets **no** run cap or cost ceiling ([AW-002](../DECISIONS.md#aw-002---campaigns-have-no-capacity-limits-by-default)). The only new limits protect this computer: how many worker processes it can host safely. They delay work; they never end it.
- It adds no model calls for waiting or scheduling. All decisions are deterministic code.
- It adds no new lock service, no second state store and no second supervisor.
- It does not enable GitHub-free admission ([D4](../PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates)), Auto Release ([D5-gate](../PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates), #13) or Telegram delivery (#1). Section 9 says what waits for which decision.

## 2. How it works today (observed)

### 2.1 One operation per campaign

- Each controller tick walks every registered campaign in turn and calls `step` for it (`src/supervisor/controller.mjs:106-123`). The query has no `ORDER BY` (`controller.mjs:107-108`), so the order is SQLite row order.
- `schedule` returns at once when the campaign has any open operation, with the comment "one slot" (`controller.mjs:504`).
- It then picks the **first** runnable task in declaration order (`controller.mjs:525-527`) and either publishes it or dispatches one operation (`controller.mjs:528-539`).
- `dispatch` checks again, inside the fenced transaction, that the campaign has no open operation (`controller.mjs:597-598`).
- `campaignLimits` gives `slots: 1` by default (`src/supervisor/campaign.mjs:66-73`), and validation rejects any other value (`campaign.mjs:118`).
- The coordinator lane is a separate single slot with its own lease (`controller.mjs:124-130`, `src/supervisor/coordinator.mjs:17`, `coordinator.mjs:258-262`).

There is **no** limit across campaigns. Ten registered campaigns can run ten workers at once on one host, whatever its memory or CPU (observed: nothing in `tick` or `dispatch` counts operations of other campaigns).

### 2.2 State, leases and fencing

- SQLite is the single mutation boundary (`src/supervisor/store.mjs:1-4`). Every write runs in `BEGIN IMMEDIATE` (`store.mjs:132-146`). In WAL mode that is one writer for the whole database at a time, not per campaign.
- Each campaign has its own lease with a generation number (`store.mjs:28-30`, `store.mjs:201-222`). A lease is taken over only after it expires, with generation + 1. Every fenced write first checks the lease (`store.mjs:224-229`) and extends it (`controller.mjs:141-150`).
- Workspace preparation, launch, push, PR creation and comments all run inside that fenced transaction (`controller.mjs:595-772`, `controller.mjs:779-786`, `controller.mjs:813-873`, `controller.mjs:1244-1254`). So today two git commands in the same main checkout never run at once, even across campaigns.
- An operation's id is `<campaign>.<task>.<kind>.<attempt>` and doubles as a unique idempotency key (`controller.mjs:631-632`, `store.mjs:38-44`). The operation row commits before the runner starts (`controller.mjs:742-751`, then `controller.mjs:775`).

### 2.3 Runner containment and recovery

- The runner takes an exclusive `run.lock`, writes `runner.json` with its process identity and heartbeats (`src/supervisor/runner.mjs:18-29`). It holds a Windows Job Object; `result.json` is written only after every process in the job stopped (`runner.mjs:35-44`).
- A recorded but unlaunched operation is launched again; `run.lock` allows only one runner (`controller.mjs:235-249`). A launch marker without a runner receipt raises a process-ownership blocker after a grace period, never a second launch (`controller.mjs:239-241`, `controller.mjs:782-785`).
- A stale heartbeat is stopped through the recorded job before the run counts as lost (`controller.mjs:250-257`, `src/supervisor/proc.mjs:144-148`).
- Cancel stops each open run through containment and returns its task to the earlier phase (`controller.mjs:221-232`); the campaign becomes `cancelled` only when no operation is open (`controller.mjs:164-172`).
- Publication looks up an existing PR or marked comment before creating one (`controller.mjs:830-863`), and publishes only while the campaign is `registered` and the task is still `verified` (`controller.mjs:816`).

### 2.4 Provider waits

- `executor_waits` is keyed by `(campaign_id, executor_kind)` (`store.mjs:45-47`). It is written per campaign on quota, auth, launch failure or an unavailable host (`controller.mjs:386-387`, `controller.mjs:612-615`, `controller.mjs:721-722`), read per campaign (`controller.mjs:564`), cleared per campaign by a recheck (`controller.mjs:188`) and by a successful result (`controller.mjs:319`).
- A single-provider campaign holds all its dispatches until the latest quota reset recorded on **its own** tasks (`controller.mjs:62-64`, `controller.mjs:523`, `controller.mjs:406`).
- So when campaign A finds the Claude account exhausted, campaign B on the same account still dispatches to it, fails, and records its own wait. #5 scope D names this as a review risk; it is not a reproduced incident.

### 2.5 Work ownership across campaigns

- At this base there is **no** cross-campaign ownership check: `src/supervisor/work-ownership.mjs` does not exist and `campaignStart` inserts a new campaign without one (`src/supervisor/api.mjs:11-28`).
- Scope A of #5 is planned as the port of archived historical regression by campaign task `example-foundation/F2-DUPLICATE`. That PR adds an optional task `workKey`, an exact task fingerprint and `findWorkConflict(store, declaration)`. The check runs inside the registration transaction and derives ownership from the `campaigns` and `operations` rows, with no lock table. This design builds on that shape (section 4.3). It is **planned**, not merged.

## 3. Every place that assumes one slot, and what replaces it

| # | Where (task base) | What it assumes | Replacement | Slice |
| --- | --- | --- | --- | --- |
| 1 | `controller.mjs:504` | Any open operation stops the campaign's scheduling. | The admission pass (section 4.1) counts open operations against the campaign's fan-out, not against 1. | S4 |
| 2 | `controller.mjs:525-528` | One candidate per tick; a `verified` task waits until the running operation ends, because line 504 returned first. | Publication runs every tick for every `verified` task. It is not a worker and uses no capacity. Workers are chosen by the admission pass. | S2, S4 |
| 3 | `controller.mjs:597-598` | The in-transaction recheck refuses a second open operation. | The same transaction re-evaluates the full admission predicate (fan-out, host ceiling, write domain, account) from SQLite rows. It refuses only when a predicate fails. | S4 |
| 4 | `controller.mjs:482` | Integration refresh is skipped while any operation is open. | Refresh runs when a gated task is due, whatever else is running. The fetch stays inside the fenced transaction. | S2 |
| 5 | `controller.mjs:973-976` | Status and next action describe `open[0]` only. | Status lists every open operation; the campaign is `verifying` only when all open operations verify. | S2 |
| 6 | `controller.mjs:321-326` | Any finishing operation clears the campaign's `process-ownership` blocker. With two operations, B finishing would clear A's unresolved blocker. | The blocker records its operation id; only that operation's settlement clears it. | S2 |
| 7 | `controller.mjs:62-64`, `:406`, `:523`, `:980` | A usage limit is held per campaign, from that campaign's task timers. | One wait per provider account across all campaigns (section 4.5). | S1 |
| 8 | `store.mjs:45-47`; `controller.mjs:188`, `:319`, `:386-387`, `:564`, `:612-615`, `:721-722` | Executor waits are per campaign. | New `provider_waits` table keyed by account; reads take the later of both tables during migration. | S1 |
| 9 | `controller.mjs:759` | `capacityAvailable: true` is a constant in the C0 admission input. | The scheduler decides capacity **before** the operation is recorded. A `false` would turn into a stalled `admission-blocked` task (`controller.mjs:761-768`), which is wrong for "come back later". The constant stays `true`, but it is now true by construction. | S4 |
| 10 | `controller.mjs:795-796` | A dispatch waits up to `dispatchWaitMs` (15 s) for the runner receipt inside the tick. Several dispatches in one tick would delay other campaigns' lease renewals (90 s, `controller.mjs:67`). | At most one launch per tick per controller instance (section 4.1). | S4 |
| 11 | `controller.mjs:107-108` | Campaign order is unspecified; under a shared ceiling the first row would always win. | Fair order by least-recently-served project, then campaign (section 4.2). | S4 |
| 12 | `campaign.mjs:66-73`, `campaign.mjs:118` | `slots` is 1 and only 1. | `limits.slots` accepts `1..8` or `"auto"`. Omitted still means 1, so no registered campaign changes behaviour (section 4.4). | S3 |
| 13 | `api.mjs:98-111` | The cost check counts finished operations only; with one slot it can overshoot by at most one run. | When the owner declared `maxCostUsd`, each open operation is reserved at `unknownRunCostUsd` until it finishes. Nothing changes when no ceiling is declared. | S2 |
| 14 | `api.mjs:125-134`, `api.mjs:141` | Status derives provider waits from this campaign's tasks and the phase from `operations[0]`. | Status reads account waits and returns every open operation plus a wait reason per step (section 6). | S1, S7 |
| 15 | `src/dashboard/supervisor.mjs:39`, `:191`, `:197`; `src/dashboard/public/dashboard.js:185` | The dashboard shows the first open operation, the `slots` number and campaign-scoped quota waits. | Show every running step and each waiting step's plain reason (S8, owned with #11). | S8 |
| 16 | `controller.mjs:489-490`, `controller.mjs:639-640` | The base is read from `FETCH_HEAD`, which any other fetch in the same checkout overwrites. | Fetch into an explicit ref (`+refs/heads/<base>:refs/aiworks/base/<base>`) and read that ref. | S2 |
| 17 | `docs/SUPERVISOR.md:98`, `:114`, `:287` | The runbook says one slot is the only supported value and "more than one slot" is not implemented. | Updated in the slice that changes the behaviour. | S4 |

Kept on purpose: the coordinator lane stays one run at a time (`controller.mjs:124`). Owner messages are rare and must stay in order.

## 4. Design

### 4.1 Admission: one pass, one authority

The scheduler is a function inside the existing controller, not a new process. Each tick:

1. **Settle.** For each campaign this instance holds a lease for, `step` runs as today: events, owner intervention, reconcile every open operation, integration refresh, publication of `verified` tasks, status. It no longer dispatches.
2. **Collect.** Each campaign returns its *candidates*: tasks that are runnable, unblocked, past their retry time and whose dependencies are done (the predicate at `controller.mjs:525-526`, without "first only"). Verify candidates are listed before implement candidates, so work in progress finishes first.
3. **Order.** Candidates are ordered fairly (section 4.2).
4. **Admit one.** The first candidate that passes every admission check below is dispatched through the existing `dispatch` and `launch`. At most one launch per tick per instance. With a 5 s tick (`controller.mjs:67`) that is up to 12 launches a minute: plenty for runs that last minutes, and it keeps every lease renewal on time (row 10).

**Admission checks.** All are evaluated inside the same `BEGIN IMMEDIATE` transaction that inserts the operation row, from SQLite rows only:

| Check | Passes when | Wait reason if not |
| --- | --- | --- |
| Campaign state | `control = 'registered'`, no campaign blocker, budget not exhausted (unchanged, `controller.mjs:597-598`). | owner / paused / blocked |
| One operation per task | The task has no open operation. Also enforced by a partial unique index on `operations(campaign_id, task_id) WHERE state IN ('recorded','dispatched')`. | already running |
| Campaign fan-out | Open operations of the campaign < its current fan-out (section 4.4). | `campaign-fanout` |
| Host ceiling | Open operations across **all** campaigns < host ceiling (section 4.6). | `host-capacity` |
| Host pressure | The latest host sample shows no pressure (section 4.6). The sample can only refuse, never admit. | `host-pressure` |
| Write domain | No *holder* overlaps the candidate's write domain, in any campaign (section 4.3). Implement only; verify and report runs are read-only. | `write-domain` |
| Provider account | The chosen provider's account has no active wait and is under its concurrency limit (section 4.5). | `provider-cooldown` / `provider-concurrency` |
| Integration | Unchanged `requiresMergedDependencies` check (`controller.mjs:638-647`). | `integration` |

**Why SQLite stays the single work authority.**

- Every input that decides admission (open operations, task states, fan-out, account waits, write-domain holders, ownership from #5) is a row in `supervisor.db`. It is read and acted on in one `BEGIN IMMEDIATE` transaction. The operation insert commits in that transaction or not at all.
- SQLite admits one writer at a time for the whole database (`store.mjs:132-146`). So two controller instances holding leases for different campaigns cannot both pass the host ceiling or claim the same write domain. The second one's transaction sees the first one's committed row.
- Nothing in memory is authoritative. `this.held` (`controller.mjs:96`) stays a cache of lease generations, as today. A restarted controller rebuilds everything from the store.
- The host sample is an input, not state. It can only make admission stricter.
- Leases stay per campaign. No global lease is needed, because global facts are checked inside the transaction, not owned by an instance.

### 4.2 Fairness across projects and campaigns

Order of candidates:

1. Project (`target.tenantId` + `target.projectId`) whose most recent admitted operation is **oldest**. Projects never served come first.
2. Within a project, the campaign whose most recent admitted operation is oldest; then campaign `created_at`, then id.
3. Within a campaign: verify before implement; then declaration order (`ord`).

"Most recent admitted operation" is `MAX(operations.created_at)` grouped by project or campaign, joined to the campaign's declaration. It is derived from existing rows; there is no new fairness state to lose or repair.

**No starvation.** Each admission goes to the least-recently-served project that has an admissible candidate. A project with an admissible candidate therefore waits at most for one admission per other such project. A busy repository with many ready steps gets one turn per round, like a quiet one. A candidate that is not admissible (say its files are busy) does not block the next one: the pass moves on to the next candidate.

When the host has room for several workers, the round goes on across ticks, so each project gets one more worker before any project gets a third.

### 4.3 Write domains and work ownership

A **write domain** is the part of a project one implement step may change.

- **Declared:** a commit task may list `writes`: repository-relative path prefixes (`src/dashboard/`, `docs/SUPERVISOR.md`) and named exclusive resources (`resource:port-4318`, for steps whose tests bind a fixed port). It is part of the immutable scope digest (`campaign.mjs:60-61`), like `workKey`.
- **Derived:** a commit task without `writes` owns the **whole repository**. This is the safe default: such a step never runs alongside another writer in the same repository. Child tasks created inside an approved envelope (#8, `docs/design/WORK_ENVELOPE.md`) carry `writes` in their versioned plan; the scheduler treats them exactly like declared ones.
- **None:** report tasks and all verifiers are read-only (`controller.mjs:666`). They never hold or wait for a write domain. A report's issue comment is an external write, but it is idempotent by marker (`controller.mjs:842-863`).
- **Key:** a domain belongs to `tenantId + repository` (as scope A matches, case-insensitive). Different repositories never conflict. Two tasks with the same `workKey` always conflict, whatever their paths.

**Overlap.** Two path prefixes overlap when one is a prefix of the other, compared case-insensitively (Windows file systems fold case). Resources overlap when the names are equal. The whole-repository domain overlaps everything in that repository.

**Who holds a domain.** A holder is computed from existing rows, never stored as a separate lock:

| Task state (any campaign, same tenant + repository) | Holds its domain? | Why |
| --- | --- | --- |
| Open implement operation (`recorded`, `dispatched`) | Yes | Active writer. Includes a run whose launch is unknown or whose process ownership is unresolved: suspicion is not proof it stopped. |
| `implemented`, `verifying`, `verified` | Yes | Its commit is not yet integrated; a second writer would branch from a base without it. |
| `done` with a commit deliverable, not yet in the fetched base branch | Yes | Published but unmerged. Released when the verified SHA (or its exact-head merge) is in the base, using the existing check `missingIntegratedDependencies` (`controller.mjs:463-477`). |
| `pending` after a cancelled or abandoned attempt, nothing pushed | No | Nothing was published. Its worktree stays and is reused by the same task only. |
| Campaign `paused` | Yes, for the rows above | Pausing does not release ownership (scope A rule). |
| Campaign `cancelled` or `finished` | Only for published-but-unmerged commits | Scope A releases registration ownership; the unmerged PR still changes those files. Released when merged or closed. |

So a domain is held from the first implement dispatch until the change is integrated or provably never published. This is #5 scope B ("extend ownership through dispatch and verified integration ... do not create an indefinite lock"). It is implemented as `domainHolders(store, candidate)` next to `findWorkConflict` in `src/supervisor/work-ownership.mjs`. That is one module, one rule set and no new lock table.

**Enforcement.** A declared domain is checked, not trusted. When an implementer returns `resolved`, the controller already checks the commit (`controller.mjs:296-300`). It also runs `git diff --name-only <base>..<head>`. Since [AW-013](../DECISIONS.md#aw-013---planned-files-are-a-plan-not-a-stop) a changed path outside `writes` is not a stop: the verifier's packet lists it and the verifier judges it. Only a secret-like path, or one inside an envelope's `denyWrites`, makes the result a **boundary violation**. The task then waits for the owner and is never retried on that provider. Paths are compared after normalising separators and case.

**Isolated worktrees.** Each task already has its own worktree and branch (`src/supervisor/adapters/git.mjs:22-37`). Each verify attempt has its own detached checkout (`git.mjs:42-54`). Parallel steps therefore never share a working directory. They share the main checkout's object store and refs. All commands that change the main checkout (fetch, `worktree add`, push) stay inside the store's write transaction, so they never run at the same time (section 2.2). Explicit refs replace `FETCH_HEAD` (row 16), so a fetch by the owner or another tool cannot change the base the scheduler reads.

**Local-only projects.** The domain key and the integration check are behind one interface: "is this verified revision in the project's base?" For GitHub projects that is today's check. For local Git and plain folders ([D1](../PROJECT_WORKSPACE_PLAN.md#31-project-connection---github-optional-owner-approved-d1-2026-10-12)) it is the local apply ledger from #7 (`docs/design/PROJECT_CONNECTION.md`). Nothing in the scheduler needs a PR to exist. Running local-only projects still waits for D2 and D4 (section 9).

### 4.4 Fan-out: start at one, grow on useful results

`limits.slots` in a declaration:

- omitted or `1`: exactly today's behaviour, one operation at a time for that campaign. Every campaign already registered keeps its authorization unchanged.
- `2..8`: the owner's own maximum for that campaign. Honoured like any declared limit.
- `"auto"`: adaptive, up to the host ceiling. New work programs approved through the #8 envelope use `"auto"` (D7 below).

Changing `slots` on a registered campaign needs `authorization.version + 1`, as every limit does (`api.mjs:41-43`, `api.mjs:80-81`).

**Adaptive fan-out** (`"auto"`, or an integer as the upper bound):

- Starts at **1**.
- **Grows by 1** when an operation of the campaign ends with a *useful result* **and**, at that moment, another candidate of the campaign was refused only by `campaign-fanout`. Growth needs both a real result and real waiting work, so nothing grows for ceremony.
- **Shrinks by 1** (minimum 1) on a failed run: `lost`, `timeout`, `exit-without-result`, `invalid-result`, `spawn-failed`, `error`, or `evidence-unavailable`.
- **Drops to 1** on thrash: two failed runs within one backoff window, or a parallel step whose commit check fails because its base moved.
- Provider throttling and host pressure are handled at the account and host level (sections 4.5, 4.6). They stop admission without wiping a campaign's learned fan-out.

A **useful result**: an implement run that returned `resolved` and passed the deterministic commit checks, or a verify run that `accepted`, or one that `rejected` with at least one blocking finding (it found a real problem). Refunded runs (`runNotCounted`, `src/supervisor/adapters/executors.mjs:22`) are neither useful nor failed.

The current value lives in a new additive table `capacity(scope, id, value, reason, updated_at)`, created with `CREATE TABLE IF NOT EXISTS` like the owner-intervention tables (`store.mjs:180-181`), so the store version does not change. Every change is journalled (`fanout-raised`, `fanout-lowered`, with the reason). A restart or takeover keeps the learned value; the host ceiling and pressure gate still apply.

### 4.5 Provider accounts: one cooldown, one concurrency limit

- **Account identity.** `config.json` may map executor kinds to account names: `"providerAccounts": { "claude-cli": "claude-main" }`. Without a mapping, the account is the executor kind on this host: every campaign using `claude-cli` here shares one account. If two campaigns really use different accounts, this default makes one wait longer than needed; it never sends work to an exhausted account. No credential or account secret is read or stored: only a name the owner chooses (see owner question Q1).
- **One wait per account.** New table `provider_waits(account, executor_kind, retry_at, reason, campaign_id, updated_at)`. Quota, auth and host-unavailable outcomes write the account's row instead of a campaign row. `executorChoice` reads it for every campaign. A single-provider campaign's hold (`controller.mjs:62-64`) becomes this same row. During migration, reads take the later of `provider_waits` and the old `executor_waits` row, so a wait recorded before the upgrade is still honoured.
- **Who may clear it.** A successful result on that account clears it (the account works). A campaign `recheck` clears the waits of the accounts that campaign uses and journals that in every campaign that uses them. The owner's "the limit lifted" is about the account, not one campaign.
- **Concurrency per account.** No limit until the provider throttles. On a `quota` outcome, the account's concurrency limit is set to half of the operations open on it at that moment, with a minimum of 1. It then grows by 1 per useful result on that account while another candidate waited for it. This adds no cap where the provider never complained.
- **Fallback order is unchanged.** A cli-chain still moves to the next authorized provider (`controller.mjs:383-399`). Permission denials are still never routed around (`controller.mjs:557`). AW-002 still holds: an accepted usage limit is a silent external wait (OWNER_INTERVENTION rate limits).

### 4.6 Host safety: ceiling and pressure

These protect workstation. They are **not** AW-002 limits: they never stop a campaign, never count runs or money, and never notify the owner. They only decide "not now".

- **Host ceiling.** At most `scheduler.maxWorkers` worker operations at once, across all campaigns. It is set in the data directory's `config.json` (local machine config, not a campaign declaration). Default: `clamp(floor(os.availableParallelism() / 4), 1, 4)`. Workers run full test suites, which are CPU heavy. The coordinator does not count against it (owner messages must not queue behind work), but it does count in the pressure sample.
- **Pressure sample.** Taken at most once per tick, in-process, without model calls:
  - free memory below `max(2 GiB, 10% of total)` (`os.freemem`, `os.totalmem`);
  - CPU busy above 90% over the last 60 s, from `os.cpus()` time deltas (`os.loadavg` is always zero on Windows);
  - free disk on the worktree volume below 5 GiB (`fs.statfsSync`); each worktree may install dependencies;
  - runner heartbeats late: any open run whose heartbeat is older than three intervals but younger than `staleMs`. This means the host is starving runners, as measured in `tests/supervisor/measure-liveness.mjs`.
- **Behaviour.** Under pressure no new operation starts; running ones continue untouched. The journal records `host-pressure` once per episode, with the signal. When it clears, admission resumes one launch per tick, which is slow start by construction. Thresholds are config values with these defaults.
- **Scheduler switch.** `scheduler.enabled` (default `false`). When it is false, the controller behaves as today: each campaign has its own single slot and there is no host ceiling. This lets slices S1 to S7 merge and run without changing live behaviour until the owner enables it (Q2).

### 4.7 Verification sequencing

- One task has at most one open operation (unique index, section 4.1). Its implementer and its verifier therefore never overlap, and a repair round never overlaps its own verification.
- A verifier still runs in a fresh session on a fresh detached checkout of the exact head (`controller.mjs:658-663`). Stale verification is still rejected (`controller.mjs:301-303`).
- Verify candidates are ordered before implement candidates in the same campaign (section 4.2). Finishing reviewed work beats starting new work, and it releases write domains sooner.
- Parallel steps are verified one branch at a time. The combined result of two parallel branches is checked by the project's own merge gate, exactly as for two campaigns today. This design does not claim combined verification.

### 4.8 Crash, takeover, unknown outcome and cancellation

| Case | What happens | Why no duplicate external write |
| --- | --- | --- |
| Crash after recording two operations, before launching either | The new instance launches each recorded operation once (`controller.mjs:235-249`). | One `run.lock` per run directory (`runner.mjs:18`). The operation ids are unchanged. |
| Takeover while three runs are live | The new lease holder adopts each run by heartbeat and consumes its result. | Admission counts the three as open, so it neither exceeds the ceiling nor claims their domains again. Results are applied once (`controller.mjs:310-311`). |
| Two controller instances at once | Their admissions serialise on the SQLite write lock; each sees the other's committed operations. | Write-domain and ceiling checks are inside the inserting transaction. |
| Launch outcome unknown (launch marker, no runner receipt) | Process-ownership blocker for that operation only (row 6). The operation keeps counting against the ceiling, its account and its write domain. | No replacement is dispatched from missing files alone (`controller.mjs:459`). |
| Crash between push and PR, or after a report post | Unchanged lookup before create (`controller.mjs:830-863`). Two tasks publishing in one tick run one after the other in the fenced transaction. | Exactly one PR per branch; comments found by marker. |
| Provider quota during parallel runs | The account wait is written once; all campaigns using it stop dispatching to it. Running operations finish normally. | No new run is sent to the exhausted account; no retry storm. |
| Cancel one campaign while others run | Its open runs are stopped through containment, one by one (`controller.mjs:221-232`). Its active-writer domains are released only after containment confirms each stop. Other campaigns are untouched. | Publication requires `registered` (`controller.mjs:816`), so a cancelled campaign publishes nothing new. |
| Cancel with a published, unmerged PR | The PR stays, and so does its write domain, until it is merged or closed. | No second PR for those files can be started meanwhile. |
| Owner fetch or stale base ref | The scheduler reads its explicit base ref, not `FETCH_HEAD`. | A worktree never starts from a stale or foreign base. |
| Duplicate repair in another campaign | Refused at registration by scope A. For campaigns registered before scope A, the write-domain holder check serialises them at dispatch. Status names the holder. | Two writers on one logical repair cannot both be active. |

## 5. Synthetic tests

All tests use disposable stores, disposable git repositories and the synthetic executables in `tests/supervisor/fixtures/` (as `tests/supervisor/helpers.mjs:38-87` does). They make no model, network or GitHub calls. Tests that start real runners use `skipWithoutSqlite`, which needs Windows Job Objects (`helpers.mjs:18-19`). The fake worker records each call's start time (`fixtures/fake-claude.mjs:19-21`) and supports `sleep:<ms>:<mode>` (`fake-claude.mjs:32-36`), so overlap can be measured.

Each test fails if two writers ran on the same write domain or an external write repeated:

| Test name | File | Fails when |
| --- | --- | --- |
| `admission never admits two overlapping write domains` | `tests/supervisor/scheduler.test.mjs` | Over generated DAGs, prefixes, `workKey`s and resources, two admitted implement candidates have overlapping domains. Pure function test. |
| `two independent steps in one campaign overlap; conflicting writers never do` | `tests/supervisor/parallel.test.mjs` | Two `writes`-disjoint tasks under `slots: "auto"` do not overlap in time, or two same-prefix tasks do overlap. |
| `a step without declared writes owns the whole repository` | `tests/supervisor/parallel.test.mjs` | A task without `writes` runs while any other implement in the same repository is open. |
| `two campaigns on one repository never write the same domain together` | `tests/supervisor/parallel.test.mjs` | Two campaigns, overlapping `writes`: implement runs overlap, or the second starts before the first's commit is in the origin base. |
| `published but unmerged work keeps its domain until merged` | `tests/supervisor/parallel.test.mjs` | A second writer starts while the first PR's SHA is absent from origin `main`; or it never starts after the test pushes the merge. |
| `a commit that changes files outside its plan goes on to the verifier` and `a commit that changes a secret-like file or a file the plan forbids is still a boundary violation` (AW-013) | `tests/supervisor/write-domain.test.mjs` | A commit outside its plan is held for the owner, or reaches the verifier without the list of those files; or a secret-like or forbidden path is accepted or retried. |
| `two projects progress fairly under a ceiling of one` | `tests/supervisor/parallel.test.mjs` | With `maxWorkers: 1` and two projects of three tasks each, one project gets two admissions in a row while the other had an admissible candidate. |
| `fan-out grows only after useful results and shrinks on failures` | `tests/supervisor/scheduler.test.mjs` | Fan-out rises without a useful result plus a waiting candidate, or does not fall on a failed run. |
| `host pressure stops new admission and leaves running work alone` | `tests/supervisor/scheduler.test.mjs` | An injected low-memory sample still admits, or stops an open run. |
| `killed between two checkpoints: each recorded operation launches once` | `tests/supervisor/restart.test.mjs` | `AIWORKS_FAULT=after-record` with two admitted tasks gives more than one implement call per task. |
| `takeover with three live runs adopts all and dispatches none again` | `tests/supervisor/restart.test.mjs` | After the first controller is killed, any task gets a second implement call, or open operations exceed the ceiling. |
| `two controllers with parallel admission never exceed the ceiling or share a domain` | `tests/supervisor/restart.test.mjs` | Two `serve` processes: at any sample, open operations exceed `maxWorkers`, or two open implements overlap in domain. Extends the existing two-controller case (`restart.test.mjs:129-139`). |
| `an unknown launch holds its domain and capacity` | `tests/supervisor/parallel.test.mjs` | With a launch marker and no runner receipt, a same-domain task is admitted, the ceiling slot is reused, or another operation's success clears that blocker. |
| `killed between push and PR with two tasks publishing: one PR each` | `tests/supervisor/restart.test.mjs` | `AIWORKS_FAULT=after-push` with two verified tasks yields more than one PR per branch. |
| `one account cooldown holds every campaign using that account` | `tests/supervisor/provider-accounts.test.mjs` | After campaign A records a quota wait on `claude-cli`, campaign B makes any `claude-cli` call before the reset. |
| `different accounts cool down independently` | `tests/supervisor/provider-accounts.test.mjs` | With `providerAccounts` mapping two names, a quota on one delays the other. |
| `a throttle lowers account concurrency without a retry storm` | `tests/supervisor/provider-accounts.test.mjs` | After a quota outcome, open runs on that account exceed half of those open before it, or quota runs repeat inside the wait. |
| `cancelling one campaign stops only its runs and releases domains after containment` | `tests/supervisor/parallel.test.mjs` | A sibling campaign's run is stopped; a domain is released before containment reports the stop; anything is published after `cancel-requested`. |
| `stale FETCH_HEAD never becomes a task base` | `tests/supervisor/parallel.test.mjs` | After the test overwrites `FETCH_HEAD` with an older commit between ticks, a new worktree starts from it. |
| `every waiting step has exactly one reason` | `tests/supervisor/scheduler.test.mjs` | A non-running, unfinished task has no reason, more than one primary reason, or a reason different from the predicate that refused it. |
| `cost ceiling reserves open runs` | `tests/supervisor/scheduler.test.mjs` | With `maxCostUsd` declared, admission lets charged plus reserved cost pass the ceiling; or a campaign without a ceiling is limited. |

Scope A's own tests (concurrent registrations, paused ownership, release on completion) come with the F2 port and are reused, not rewritten.

## 6. "Why is this waiting?"

One deterministic function, `waitReason(task, snapshot)`, returns the **first** failing check in a fixed order. Admission uses the same function, so the reason shown is the reason that decided. It returns a code, owner text, an optional time and an optional holder.

| Code | Owner text (example) | Next automatic action |
| --- | --- | --- |
| `running` | Being implemented / being checked | Result is recorded when the run ends |
| `dependency` | Waiting for "Login page" to finish | Starts when that step is done |
| `integration` | Waiting for "Login page" to be merged into main | Checks main again every minute |
| `write-domain` | Another step is changing `src/dashboard/` (PR #41 not merged yet) | Starts when that change is merged or dropped |
| `campaign-fanout` | Waiting for a free worker in this work program | Starts when a running step finishes |
| `fair-turn` | Another project goes first | Starts on its turn |
| `host-capacity` | This computer is running its maximum number of workers | Starts when one finishes |
| `host-pressure` | This computer is low on memory | Starts when memory frees up |
| `provider-cooldown` | Claude usage limit; resets at 14:05 | Tries again at 14:05 |
| `provider-concurrency` | Claude asked to slow down | Starts when a Claude run finishes |
| `retry-backoff` | Retrying after a failed attempt at 14:10 | Tries again at 14:10 |
| `owner` | Needs your decision: ... | None; listed in Needs you |
| `paused` | Paused by you | None until resumed |

`campaignStatus` returns `wait: { code, text, until, holder }` per task. The text is built only from supervisor-known fields, never from worker output, matching how the dashboard already avoids stored worker text (`src/dashboard/supervisor.mjs:181-183`). Only `owner` produces a Needs you item. A published PR that blocks other ready work appears as "merge or close PR #41 to unblock 2 steps"; that is the owner's own release gate, not a new interruption. Provider waits never reach Needs you (plan §4). The UI wording follows [D9](../PROJECT_WORKSPACE_PLAN.md#4-owner-information-architecture---one-primary-question-per-screen) (English, no "slots", "lease" or "fencing" at the primary level).

## 7. AW-002 and host safety stay separate

| | Owner budget (AW-002) | Host safety (this design) |
| --- | --- | --- |
| Where | Campaign declaration `limits` | Data directory `config.json` `scheduler` |
| Default | None | Ceiling and pressure thresholds as in section 4.6 |
| What it limits | Total runs, retries, repair rounds, dollars | Processes at the same moment |
| When reached | B3 budget decision (`controller.mjs:530-537`) | Silent `host-capacity` / `host-pressure` wait |
| Ends work | Until the owner amends | Never; only delays it |

`limits.slots` is an owner-declared per-campaign maximum, so it lives in the declaration. The adaptive value under `"auto"` is not a limit the owner set; it is the scheduler's current estimate.

## 8. Decisions taken here (not owner-reserved)

- **D7 (worker count):** adaptive by default for new work (`slots: "auto"`), with the owner's optional per-campaign integer and an optional host `maxWorkers`. No default run or cost ceiling. This follows the plan's proposed resolution (§8).
- Write domains default to the whole repository; declared `writes` narrows them and is enforced on the commit.
- Ownership of a domain is derived from rows and lasts until integration; no lock table and no expiry.
- One cooldown per account; the default account is the executor kind on this host.
- At most one launch per tick per instance; verify before implement; least-recently-served project first.
- `scheduler.enabled` is off by default; existing campaigns keep `slots: 1` behaviour.

## 9. Owner-reserved questions

None of these re-opens D1, D3, D5 or D9.

| # | Question | Recommended answer | What it unblocks |
| --- | --- | --- | --- |
| Q1 | On workstation, does any CLI (Claude, Codex, Cursor, AGY) run under more than one provider account? Accounts are the owner's provider resources, and this document cannot see them (unknown). | Treat each CLI kind as one account (the default). Add `providerAccounts` names only if the owner actually has separate accounts. | Correct cooldown grouping in S1. With the recommended default S1 ships without waiting. |
| Q2 | May the live workstation runtime turn on `scheduler.enabled` after S1 to S7 are merged, reviewed on their exact heads and rehearsed? Changing the live runtime's configuration is a production change agents may not make ([AGENTS.md](../../AGENTS.md#authorized-work)). | Yes. Use the documented upgrade procedure ([SUPERVISOR.md §6](../SUPERVISOR.md#6-installation-and-maintenance)), enable with the default ceiling, and compare `status` before and after. | Slice S9: real parallel work on workstation. |
| Q3 | How much of workstation may workers use while the owner also works on it? | Default ceiling `clamp(cores / 4, 1, 4)` plus the pressure gate; the owner can lower or raise `scheduler.maxWorkers` at any time. | The default value S9 enables with. S4 to S7 do not wait for it. |

Waiting on decisions already open elsewhere (not asked again here):

- Running fully local projects in the scheduler waits for **D2** (governance local project identity contract) and **D4** (AW-005 local admission). The interfaces in section 4.3 are built for them now and stay unused for local projects until then.
- Auto Release (**D5-gate**, #13) is not touched. The scheduler never merges, applies or deploys.
- Telegram delivery (#1) is not touched. Wait reasons are local status only.

governance provider: no governance change is needed for slices S1 to S8. The account-scoped cooldown applies the existing governance rate-limit exception; it does not change it.

## 10. Implementation slices

Every slice is one reviewable PR. Every slice that changes `src/supervisor` needs an independent review that approves its exact head before merge ([AGENTS.md](../../AGENTS.md#review-and-runtime-maintenance)). Merged is not deployed: nothing reaches workstation before S9. Each runs `npm run check`.

**S1. One cooldown per provider account** (#5 scope D)

- Outcome: a quota, auth or host-unavailable wait on an account holds every campaign that uses that account; recheck and success clear it once.
- Files: `src/supervisor/store.mjs` (additive `provider_waits`), new `src/supervisor/accounts.mjs`, `src/supervisor/controller.mjs` (wait writes and reads listed in rows 7 and 8), `src/supervisor/api.mjs` (status union of old and new waits), `docs/SUPERVISOR.md` §4, new `tests/supervisor/provider-accounts.test.mjs`.
- Tests: `one account cooldown holds every campaign using that account`; `different accounts cool down independently`.
- Acceptance: both tests fail on the task base and pass after; existing executor, unlimited and resilience tests pass unchanged.
- Depends on: nothing. It does not need parallelism.
- Waits for: nothing (Q1 refines the mapping; the default ships).

**S2. Make the controller safe for several open operations** (behaviour with one slot unchanged)

- Outcome: blockers, status, integration refresh, publication and the cost check are correct when more than one operation is open; bases come from explicit refs.
- Files: `src/supervisor/controller.mjs` (rows 2, 4, 5, 6, 16), `src/supervisor/store.mjs` (partial unique index: one open operation per task), `src/supervisor/api.mjs` (row 13 cost reservation, all open operations in status), new `tests/supervisor/multi-op.test.mjs`.
- Tests: `an unknown launch holds its domain and capacity` (blocker part); `stale FETCH_HEAD never becomes a task base`; `cost ceiling reserves open runs`; a check that a `verified` task publishes while another task runs.
- Acceptance: the existing serial suite passes unchanged; the new tests fail on the base.
- Depends on: nothing.
- Waits for: nothing.

**S3. Write domains and ownership through integration** (#5 scope B)

- Outcome: commit tasks may declare `writes`; undeclared tasks own the repository; holders are derived from rows across campaigns until integration; out-of-domain commits are boundary violations; `limits.slots` accepts `1..8` and `"auto"`.
- Files: `src/supervisor/campaign.mjs` (validation of `writes` and `slots`), `src/supervisor/work-ownership.mjs` (`domainOf`, `domainHolders`), `src/supervisor/adapters/git.mjs` (`changedPaths`), `src/supervisor/controller.mjs` (enforcement after `checkImplementation`), `docs/SUPERVISOR.md` §1, new `tests/supervisor/write-domain.test.mjs`.
- Tests: `writes outside the declared domain are a boundary violation`; holder-table cases from section 4.3 as pure tests; `published but unmerged work keeps its domain until merged`.
- Acceptance: declarations without `writes` or `slots` validate and digest exactly as before.
- Depends on: F2-DUPLICATE (scope A port) merged; S2.
- Waits for: nothing.

**S4. Scheduler admission, fairness and fan-out**

- Outcome: behind `scheduler.enabled`, one admission pass per tick admits independent ready steps across campaigns and projects, fairly, with adaptive fan-out and the host ceiling.
- Files: new `src/supervisor/scheduler.mjs` (candidates, order, admission predicate, `waitReason`, fan-out rules), `src/supervisor/controller.mjs` (tick split into settle / collect / admit; rows 1, 3, 9, 10, 11), `src/supervisor/store.mjs` (additive `capacity` table), `docs/SUPERVISOR.md` (rows 17), new `tests/supervisor/scheduler.test.mjs`, new `tests/supervisor/parallel.test.mjs`.
- Tests: `admission never admits two overlapping write domains`; `two independent steps in one campaign overlap; conflicting writers never do`; `a step without declared writes owns the whole repository`; `two campaigns on one repository never write the same domain together`; `two projects progress fairly under a ceiling of one`; `fan-out grows only after useful results and shrinks on failures`; `every waiting step has exactly one reason`.
- Acceptance: with `scheduler.enabled: false` the full existing suite passes unchanged; with it on, the tests above pass, and a serial-vs-parallel run of the same synthetic DAG finishes in less elapsed time with the same published SHAs.
- Depends on: S1, S2, S3.
- Waits for: nothing.

**S5. Host pressure sampling**

- Outcome: memory, CPU, disk and heartbeat-lag samples stop new admission under pressure; running work continues.
- Files: new `src/supervisor/host.mjs` (sampler, injectable for tests), `src/supervisor/scheduler.mjs` (gate), `tests/supervisor/scheduler.test.mjs`.
- Tests: `host pressure stops new admission and leaves running work alone`.
- Acceptance: the sampler makes no network or model calls and costs one in-process read per tick.
- Depends on: S4.
- Waits for: nothing.

**S6. Account concurrency and throttle back-off**

- Outcome: a quota outcome lowers the account's concurrency to half of its open runs; useful results raise it again.
- Files: `src/supervisor/accounts.mjs`, `src/supervisor/scheduler.mjs`, `tests/supervisor/provider-accounts.test.mjs`.
- Tests: `a throttle lowers account concurrency without a retry storm`.
- Acceptance: no limit appears for an account that never throttled.
- Depends on: S1, S4.
- Waits for: nothing.

**S7. Crash, takeover and cancellation rehearsals with parallel work**

- Outcome: the restart guarantees of `tests/supervisor/restart.test.mjs` hold with several open operations and two controllers.
- Files: `tests/supervisor/restart.test.mjs`, `tests/supervisor/parallel.test.mjs`; controller fixes only where a test exposes a defect (named in the PR).
- Tests: `killed between two checkpoints: each recorded operation launches once`; `takeover with three live runs adopts all and dispatches none again`; `two controllers with parallel admission never exceed the ceiling or share a domain`; `killed between push and PR with two tasks publishing: one PR each`; `cancelling one campaign stops only its runs and releases domains after containment`; `an unknown launch holds its domain and capacity`.
- Acceptance: every listed test passes on Windows; none is skipped there.
- Depends on: S4.
- Waits for: nothing.

**S8. Wait reasons in status and the project work view**

- Outcome: the owner sees every running step and one plain reason, with the next automatic action, for each waiting step.
- Files: `src/supervisor/api.mjs` (`wait` per task), `src/dashboard/supervisor.mjs`, `src/dashboard/public/dashboard.js` (row 15), `tests/dashboard/` and `tests/supervisor/status.test.mjs`.
- Tests: status returns one reason per waiting task built only from supervisor-known fields; the dashboard never renders worker text in a reason.
- Acceptance: blind owner review of the work view per UX-002.
- Depends on: S4. The dashboard part follows the #11 work view design (`docs/design/` from the experience campaign) and its file owner; it does not change those files while another campaign owns them.
- Waits for: nothing owner-reserved.

**S9. workstation rehearsal and enablement** (runbook, no code)

- Outcome: the live runtime runs the merged scheduler with `scheduler.enabled: true`.
- Files: `docs/SUPERVISOR.md` §6 (enablement and rollback: set `enabled: false`), `docs/STATUS.md`.
- Tests: the full suite at the deployed SHA; then a disposable two-project campaign pair on workstation, compared serial and parallel. Status before and after, per [AGENTS.md](../../AGENTS.md#review-and-runtime-maintenance).
- Acceptance: observed on workstation and labelled verified only there: independent steps overlap, conflicting ones do not, and no duplicate PR or comment appears.
- Depends on: S1 to S7 merged (S8 recommended).
- Waits for: **owner** Q2 (and Q3 for a non-default ceiling).
