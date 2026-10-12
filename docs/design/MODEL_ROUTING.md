# Cost- and quality-aware model choice per task role

**Status:** design only. Nothing in this document is built, merged into the runtime or deployed. Refs [#10](https://github.com/netbka/aiworks/issues/10), [#5](https://github.com/netbka/aiworks/issues/5), [#14](https://github.com/netbka/aiworks/issues/14).

**Basis:** `netbka/aiworks` at `143208c3f62d37040de3f1b145b41957de62f868` (the task base). Every "today" statement is **observed** in that revision and cites `file:line` there. Nothing here was checked on HomePc: how the live runtime behaves, which models the owner's accounts allow and how they are billed are **unknown** to this document. Proposed behaviour is **planned**. The Engineering Platform role catalog was read once, read-only, from `netbka/engineering-platform` main (`registry/agents.json`, blob `84f078e6`) on 2026-10-12; that is an **observed** document, not a runtime check.

**Inputs:** [PROJECT_WORKSPACE_PLAN.md §5.3](../PROJECT_WORKSPACE_PLAN.md#53-rolemodelcost-routing) and §7, [#10](https://github.com/netbka/aiworks/issues/10), [ADAPTIVE_SCHEDULER.md](ADAPTIVE_SCHEDULER.md) (merged design, PR [#20](https://github.com/netbka/aiworks/pull/20)), [SUPERVISOR.md](../SUPERVISOR.md), [DECISIONS.md](../DECISIONS.md) (AW-001, AW-002, AW-005). Engineering Platform rules apply through [AGENTS.md](../../AGENTS.md) and are linked, not repeated: [Owner Intervention, rate limits](https://github.com/netbka/engineering-platform/blob/main/docs/OWNER_INTERVENTION.md#rate-limits--quotas), [Agent Operating Model](https://github.com/netbka/engineering-platform/blob/main/docs/AGENT_OPERATING_MODEL.md), [Delivery Practices](https://github.com/netbka/engineering-platform/blob/main/docs/DELIVERY_PRACTICES.md).

## 1. What the owner gets

- **The right model for each step.** A small, safe change goes to a cheaper model. Architecture, hard debugging, risky changes and independent review go to a stronger one. "Cheap first" is not the rule: if a cheap model keeps needing repairs, the step starts higher next time.
- **It moves up only on evidence.** When a step's work is rejected or comes back unusable, the next try uses a stronger model. A permission denial, a usage limit or a login problem never moves work to a stronger or less restricted model.
- **Review stays independent.** A check always runs in a fresh session, on a model the work program already authorizes. It never reuses the worker's session. For risky work it prefers a different model from the one that did the work.
- **Every choice can be explained and replayed.** Each run records which model was chosen, from which options, and why. The same record gives the same choice again.
- **The owner can pin a model.** A pin overrides the automatic choice for that work program. It never widens permissions.
- **Honest cost.** Costs are shown in the units each provider reports: dollars where a CLI reports dollars, tokens where it reports tokens, and "unknown" where it reports nothing. Unknown is never counted as free. No saving is claimed until it is measured against a recorded baseline (section 8).

What it does **not** do:

- It sets **no** run cap or cost ceiling ([AW-002](../DECISIONS.md#aw-002---campaigns-have-no-capacity-limits-by-default)). Owner-declared budgets keep working as today.
- It makes **no** model call to decide. The router is deterministic code that runs only when a step is dispatched, never on an idle tick.
- It never switches account, subscription or login, and never uses a model or provider the work program does not list.
- It does not enable GitHub-free admission ([D4](../PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates)), Auto Release ([D5-gate](../PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates), #13) or Telegram delivery ([#1](https://github.com/netbka/aiworks/issues/1)). Section 10 says what waits for which decision.

## 2. How it works today (observed)

### 2.1 Which executor runs a step

- A campaign declares one executor or a `cli-chain` of 1 to 4 providers in priority order (`src/supervisor/campaign.mjs:129-136`, `campaign.mjs:82`). Each provider has **one** model: required for Claude and AGY (`campaign.mjs:144-151`), optional for Codex and Cursor (`campaign.mjs:142`). There is no notion of tier, risk or task role in the declaration (task keys: `campaign.mjs:170-172`).
- `executorChoice` walks the declared order and returns the **first** provider that passes these filters (`src/supervisor/controller.mjs:563-591`):
  - research-only providers only for report tasks (`controller.mjs:573`);
  - web tasks only on browser workers, and AGY only on web tasks (`controller.mjs:575`, `src/supervisor/adapters/executors.mjs:14`);
  - the CLI command is configured on this host (`controller.mjs:576-581`);
  - the provider supports the role (`controller.mjs:582-583`, `roleUnavailableReason` at `executors.mjs:124-134`: AGY only web; Cursor no commit roles; Codex no commit roles on Windows);
  - no active `executor_waits` row for that provider (`controller.mjs:584-589`).
- The role is `verification` when the task is `implemented`, otherwise `implementer` (`controller.mjs:582`, `controller.mjs:665`).
- After a task-level failure, the provider that failed is moved behind the others for the next attempt (`lastFailedExecutor`, `controller.mjs:549-561`). It is **not** moved after quota, auth, launch or host failures (`controller.mjs:555`), and **not** after a denial: "Never route around a denial" (`controller.mjs:556-557`).
- Host and project checks (`unavailableReason`, `executors.mjs:80-122`) run **after** the choice, inside dispatch. A failure writes a wait and returns without dispatching (`controller.mjs:714-724`); the next tick chooses again.
- A quota, auth, launch or unavailable outcome in a chain writes a wait for that provider and falls back to the next one (`controller.mjs:383-399`). Each fallback is a new, separately counted operation (`controller.mjs:750`).
- The coordinator always runs Claude with `cfg.model ?? 'opus'` (`src/supervisor/coordinator.mjs:292`).

So today the model is fixed per provider and per campaign. The only "routing" is the declared order plus fallback on unavailability or failure.

### 2.2 How a verifier is kept independent

- Each operation gets a new random session id (`controller.mjs:687`). A result is accepted only from that exact session (`controller.mjs:313-316`).
- A verifier runs on a fresh detached checkout of the exact head (`controller.mjs:658-663`, `src/supervisor/adapters/git.mjs:41-45`) and read-only (`controller.mjs:666`; Claude denies edits and commits, `src/supervisor/adapters/claude.mjs:125`, `claude.mjs:130-136`; Codex uses the `read-only` sandbox, `executors.mjs:205`).
- A stale verification (head moved) is rejected (`controller.mjs:301-303`).
- The verifier is chosen by the same `executorChoice` and the same order as the implementer. Implementer and verifier are therefore usually the **same provider and model**, in different sessions (observed from `controller.mjs:563-591`; nothing compares the two).
- The worker-context policy blocks a non-implementer whose session is not independent and read-only (`scripts/lib/worker-context.mjs:149-151`). Dispatch always plans a fresh session (`controller.mjs:753-760`).

### 2.3 Cost and usage records

| Provider | What the adapter records | Where |
| --- | --- | --- |
| Claude | `total_cost_usd` as `costUsd`, input/output/cache-read/cache-creation tokens, turns, permission-denial count | `claude.mjs:298-308` |
| Codex | tokens; cached input marked as a subset of input; `costUsd: null` | `executors.mjs:249-251`, `executors.mjs:260` |
| Cursor | nothing: `usage: null`, `costUsd: null`, `measured: false` | `executors.mjs:252-260` |
| AGY | input/output/cache-read tokens; `costUsd: null` | `src/supervisor/adapters/agy.mjs:222-225` |
| Coordinator | `total_cost_usd` only, in `coordinator_runs.cost_usd` | `coordinator.mjs:213`, `coordinator.mjs:379`, `src/supervisor/store.mjs:57-59` |

- The receipt sits in `operations.outcome` (`controller.mjs:318`) and in the `operation-finished` journal entry with `costUsd`, `usage`, terminal verdict and blocking-finding count (`controller.mjs:348-355`).
- Reported dollars add to `campaigns.cost_usd` (`controller.mjs:328`). Runs refused before work, unavailable executors and admission blocks are refunded (`executors.mjs:19-22`, `controller.mjs:317`, `controller.mjs:329-334`).
- An optional `maxCostUsd` counts every run without reported dollars at a declared `unknownRunCostUsd`, never zero (`src/supervisor/api.mjs:98-111`, `campaign.mjs:122-127`).
- The **model** is not stored on the operation. Only `executor_kind` is (`store.mjs:38-43`, `controller.mjs:746`, journal `controller.mjs:751`). The model must be read from the declaration in force at the time; executor changes are journalled with the old and new declaration (`api.mjs:44-46`).
- Whether Claude's reported dollars are what the owner actually pays on their plan is **unknown**.

### 2.4 Provider waits

`executor_waits` is keyed by campaign and executor kind (`store.mjs:45-47`). The merged scheduler design replaces it with one wait per provider account (ADAPTIVE_SCHEDULER.md §4.5, slice S1). This design uses whichever is in place; it adds no wait table of its own.

### 2.5 The role catalog

- Engineering Platform's `registry/agents.json` lists 15 roles with `id`, `purpose`, `authority`, `must_not`, `returns`, `escalates`, and for reviewers `independent_from` (observed in EP main, blob `84f078e6`). Examples: `verification-agent` (independent from the architects and engineers), `security-reviewer` (independent from `backend-engineer`, `infrastructure-sre`), `product-reviewer`, `release-agent`.
- AIWorks already reads that file from the governance checkout, for the dashboard roadmap only (`src/dashboard/roadmap.mjs:62-63`; root rules at `src/supervisor/governance.mjs:1-4`). The supervisor does not read it.
- The test fixture copy has an empty `roles` list (`tests/fixtures/governance/registry/agents.json:3`).
- Worker packets know four roles: `implementer`, `verification`, `security-review`, `browser-review` (`scripts/lib/worker-context.mjs:85`). The controller uses only the first two (`controller.mjs:665`).

## 3. Indicators: what kind of step is this?

Every step gets three deterministic indicators. They are computed from the approved declaration and the task's recorded history only: no model call and no reading of free text. Each rule is part of the versioned router policy (`routing-policy/1`), so a later change cannot silently change old receipts.

### 3.1 Role

- **Stage:** `implement` or `verify`, as today (`controller.mjs:582`).
- **Catalog role:** an optional task field `role`, an id from EP `registry/agents.json`. It is checked against the catalog when the campaign is registered. The default is no catalog role for an implementer and `verification-agent` for a verifier. AIWorks reads the catalog; it never copies it (section 7).
- **Browser:** a task with `web` (`campaign.mjs:197-209`) is a browser step. Only browser workers are candidates, as today.

### 3.2 Risk

| Level | When (first rule that matches wins) |
| --- | --- |
| **R2 high** | The catalog role is `security-reviewer`, `database-engineer`, `infrastructure-sre` or `release-agent`; or the task's write domain overlaps a declared `routing.sensitivePaths` prefix; or the task declares `routing.risk: "high"`. |
| **R1 medium** | A commit task without declared `writes` (it owns the whole repository, ADAPTIVE_SCHEDULER.md §4.3); or a web task. |
| **R0 low** | Everything else: report tasks, and commit tasks whose declared `writes` touch no sensitive path. |

`writes` comes from scheduler slice S3. Until S3 exists, every commit task is at least R1. A task may declare `routing.risk: "high"` to **raise** its level; nothing can lower a computed level. For AIWorks itself, `src/supervisor/` is the natural sensitive path, because a change there needs an independent review of the exact head ([AGENTS.md](../../AGENTS.md#changing-the-supervisor)).

### 3.3 Complexity

Points, from the declaration:

| Signal | Points |
| --- | --- |
| Deliverable is `commit` | +1 |
| More than 5 references | +1 |
| More than 12 references | +1 more |
| More than 4 acceptance criteria | +1 |
| 2 or more dependencies | +1 |
| `requiresMergedDependencies` | +1 |

**C1** is 0 to 1 point, **C2** is 2 to 3, **C3** is 4 or more. A task may declare `routing.complexity: "high"` to force C3. Repair rounds and failed attempts do **not** change the class; they drive escalation (section 5.4).

## 4. Eligibility: who may run it?

### 4.1 Candidates come only from the declaration

A campaign that opts in declares its candidates: each is an executor kind already in `executor.providers` plus a model and a tier.

```json
"routing": {
  "mode": "auto",
  "candidates": [
    { "kind": "claude-cli", "model": "haiku",  "tier": 1 },
    { "kind": "claude-cli", "model": "sonnet", "tier": 2 },
    { "kind": "claude-cli", "model": "opus",   "tier": 3 },
    { "kind": "codex-cli",  "model": "gpt-6-astra", "tier": 3 }
  ],
  "sensitivePaths": ["src/supervisor/"],
  "pin": null
}
```

- A candidate inherits everything else (permission mode, `researchOnly`) from its provider entry. So the provider list stays the list of authorized CLIs, and `candidates` is the list of authorized models.
- Tier 1 is the owner's "economy", 2 "standard", 3 "strongest". The tier is the owner's declared cost order. It is not a price.
- `routing` is part of the immutable scope digest, like `executor` (`campaign.mjs:60-61`). Changing it follows the executor amendment rule: higher authorization version, paused campaign, no open operation, journalled (`api.mjs:30-46`).
- **Without `routing`, nothing changes.** The router reproduces today's choice exactly (declared order, one model per provider) and only writes a receipt (slice R2). Every campaign already declared keeps its behaviour.

The router cannot pick a model or provider the campaign does not list, because the candidate set is built from the declaration and nothing else. The declaration is bound into every packet through `authorityDigest` (`campaign.mjs:63`, `controller.mjs:677`).

### 4.2 Filters

Each candidate passes these filters in this order, once for each role the decision needs (section 4.4). The router computes them itself from facts recorded in the receipt: the declaration, the host platform, and one host-fact entry per provider kind (section 9). The receipt's `decision.eligibility` lists **every** failing filter per candidate and per role, not only the first.

| # | Filter | Source today | Reason code |
| --- | --- | --- | --- |
| 1 | Research-only provider only for report tasks | `controller.mjs:573` | `research-only` |
| 2 | Web task only on a browser worker; AGY only on web | `controller.mjs:575` | `web-mismatch` |
| 3 | CLI command configured on this host | `controller.mjs:576-581` | `cli-not-configured` |
| 4 | Role support | `roleUnavailableReason`, `executors.mjs:124-134` | `role-unsupported` |
| 5 | Host and project support, including the Codex sandbox probe | `unavailableReason`, `executors.mjs:80-122` | `host-unavailable` |
| 6 | Account has no active wait (quota, auth, launch, unavailable) | `executor_waits` or S1 `provider_waits` | `account-wait` |
| 7 | Tier at or above the step's floor (section 5.1) | new | `below-floor` |
| 8 | Owner pin (section 6) | new | `pin-excluded` |

Filter 5 moves **before** the choice. Today it runs after the choice, and a failure costs one tick (`controller.mjs:714-724`). Its result is cached per provider for the tick, so the Codex probe still runs at most once per dispatch.

Which filters are host facts and which are pure rules:

- **Pure rules** (filters 1, 2, 4, 7, 8). The router computes them from the candidate, its provider entry's `researchOnly`, the task's `deliverable` and `web`, the role, and the host `platform`. Today's role check takes exactly these values (`roleUnavailableReason(executor, role, deliverable, platform, web)`, `executors.mjs:124-134`), and its answer differs by role: Codex on Windows may verify but not commit (`executors.mjs:129-132`). So the receipt records `platform` and each candidate's `researchOnly`, never a pre-computed role answer.
- **Host facts** (filters 3, 5, 6). They depend on this machine at this moment, so the receipt records them as observed: per provider kind, whether its CLI is configured, the host check's reason or `null`, and the account wait's reason or `null`. Host facts do not depend on the role. The host check reads the provider, the project's extension files and `web` (`executors.mjs:80-122`), not the role.

### 4.3 Verifier independence

These rules hold for every verify step, whatever the mode:

1. **Never the same session.** The verifier gets a new session id (`controller.mjs:687`), and only that session's result is accepted (`controller.mjs:313-316`). The receipt also records the implementer session(s) that produced the head under review (`inputs.implementerSessions`, section 9) and asserts that the new id differs from all of them. A test fails if it ever matches.
2. **Never an unauthorized provider or model.** Candidates come only from the declaration (section 4.1). The verifier filters are the same as above, with role `verification`.
3. **Read-only and fresh checkout**, unchanged (section 2.2).
4. **Prefer a different model for risky work.** For R2 steps, and for C3 steps, a candidate whose `(kind, model)` differs from the implementer of the head (`inputs.headImplementer`, section 9) is ranked first, if one is eligible at or above the floor. Then the receipt says `independence: "different-model"`. If none is, the same model runs in a fresh session, and the receipt says `independence: "fresh-session-same-model"`. This is a preference, not a gate. A hard requirement would block work until the owner configures a second provider. AGENTS.md forbids adding such a gate without the owner ([When to stop for the owner](../../AGENTS.md#when-to-stop-for-the-owner)).
5. **Catalog independence.** When a task declares a catalog role, the verifier's catalog role (`verification-agent`, or `security-reviewer` for R2 with a security role) must list it in `independent_from`, or the receipt records `catalog-independence: "not-declared"`. This is report-only, for the same reason as rule 4.

### 4.4 The verifier projection (implement steps)

An implement step's cost includes the check that must follow it (section 5.2). So, to rank implement candidates, the router predicts which verifier would check each one. This prediction is the **verifier projection**.

- For each implement candidate `m` that passes filters 1 to 8, the router runs the verify-stage choice as if `m` had produced the head: role `verification`, verify floor (section 5.1), verify-class history, and rule 4 above with `headImplementer = m`. The result is `v(m)`, or `null` when no verifier is eligible.
- `v(m)` can differ between candidates. Rule 4 prefers a verifier whose model differs from `m`, so `v(m1)` and `v(m2)` may not be the same model.
- Everything the projection reads is in the receipt's `inputs`: the same candidates, `platform`, `researchOnly` and host facts as the implement choice, and the verify-class rows of `inputs.history`. Host facts are taken once, at the implement dispatch, and reused for the projection.
- The projection is a prediction only. When the verify step is later dispatched, it gets its own receipt with the facts of that moment, and its own choice. A difference between the two is normal and is not an error.
- The receipt's `decision.verifierProjection` lists, per implement candidate `m`, the projected verifier, its independence value, its verify-role eligibility and the `u(v)` used. Replay recomputes this list and must get the same one (section 9).

## 5. Choice: the lowest expected cost of an accepted result

### 5.1 Floors

The floor is the lowest tier the step may start on:

| Step | Floor |
| --- | --- |
| Implement, R0 and C1 | tier 1 |
| Implement, C2 or R1 | tier 2 |
| Implement, C3 or R2 | tier 3 |
| Verify | tier 2; tier 3 when R2 or C3 |
| Any step, after escalation | the escalated tier (section 5.4) |

If the campaign declares no candidate at or above the floor, the floor drops to the highest declared tier, and the receipt says so (`floor-capped`). A campaign with one model per provider therefore keeps working.

### 5.2 Expected cost

For each eligible candidate `m` at or above the floor, the router computes from recorded history (section 5.3):

- **Acceptance rate `â(m)`**, smoothed with the tier prior: `â = (accepted + 4·p0) / (attempts + 4)`. Starting priors: `p0` = 0.6, 0.75 and 0.85 for tiers 1, 2 and 3. These are policy constants of `routing-policy/1`, to be replaced by the measured baseline (section 8) before any cohort.
  - Implement: an attempt is accepted when the verifier later accepted the head (or report) it produced.
  - Verify: an attempt is accepted when it returned a valid verdict (`accepted`, or `rejected` with a blocking finding). This measures usable reviews only. Whether a verifier missed a real defect is not visible in the store (section 8.3).
- **Mean cost per attempt `u(m)`**, in the candidate's native unit, from attempts whose cost is known. The count of attempts with unknown cost is kept beside it.
- **Expected cost of an accepted result** for an implement candidate, with its projected verifier `v = v(m)` (section 4.4): `E(m) = (u(m) + u(v(m))) / â(m)`. Each implement attempt needs a verify run, and `1/â` is the expected number of attempts. For a verify candidate: `E(v) = u(v) / â(v)`.
- `E(m)` is **unknown** when `v(m)` is `null`, when `u(m)` or `u(v(m))` is unknown, or when the two are in different units. Units are never added together. An unknown `E` never ranks as cheap: it sends the step to the tier walk (section 5.3, rule 2).

Why `v(m)` matters: `u(v)` is added before dividing by `â(m)`, so a different verifier can reverse the ranking. Example in dollars: `m1` has `u = 1`, `â = 0.5`, and `m2` has `u = 2`, `â = 0.8`. With `u(v) = 0`, `E(m1) = 2` and `E(m2) = 2.5`, so `m1` wins. With `u(v) = 10`, `E(m1) = 22` and `E(m2) = 15`, so `m2` wins. That is why the projection is part of the decision, and its inputs are in the receipt.

Planning overhead (coordinator runs) is the same for every candidate. It is reported per campaign (section 9) and does not affect the ranking.

### 5.3 Ranking

1. **Comparable dollars.** If every eligible candidate at or above the floor has at least 5 attempts in this class **and** a known `E` in the same unit, pick the lowest `E`. For an implement step, this includes each projected verifier: `v(m)` must exist and have at least 5 attempts and a known cost in the verify class. Today only Claude reports dollars (section 2.3), so this applies to Claude-only candidate sets.
2. **Otherwise, walk up the tiers.** Starting at the floor, take the lowest tier whose best candidate has `1/â ≤ 2` (at most two expected attempts). Within that tier, pick the lowest known `E` among candidates with the same unit, then the fewest expected attempts, then declared order. If no tier qualifies, use the top tier.
3. **Cold start.** With no history for this class, use the floor tier and declared order. The receipt says `basis: "cold-start"`.
4. **Ties** go to the shorter median run time, then declared order.

Units are never converted into each other. The tier walk uses the owner's declared order exactly where the router cannot compare prices honestly.

**History window.** Counted attempts (refunds excluded, `executors.mjs:22`) of this candidate and class, in this host's store, across all campaigns. Most recent 200 attempts, at most 90 days old. The router reads it inside the dispatch transaction, once per dispatch, never on an idle tick. The receipt stores the aggregated numbers and the window bounds, not the rows.

**Provider waits.** A candidate whose account waits is not eligible (filter 6). The router does not "upgrade" around it: it takes the next eligible candidate under the same rules, as the chain fallback does today (`controller.mjs:383-399`). When the scheduler's per-account concurrency limit is reached (ADAPTIVE_SCHEDULER.md §4.5), the step waits for its chosen candidate rather than taking a worse one; that limit clears within a run.

### 5.4 Escalation

Escalation is per task and per stage, and it is sticky: a task never moves down within its life.

| Outcome of the previous attempt | Counts as poor quality? | What happens next |
| --- | --- | --- |
| Verifier `rejected` with a blocking finding | yes | Repair attempt |
| `invalid-result`, `exit-without-result` | yes | Retry |
| Worker result `evidence-unavailable` | yes | Retry (the existing no-progress stop after 4 still applies, `controller.mjs:369-372`) |
| `timeout` | yes | Retry |
| Generic `error` (not a denial) | no | Retry on the same tier under the existing backoff (`controller.mjs:377-378`) |
| Permission or sandbox denial | **no** | Same candidate order; never escalated or routed around (`controller.mjs:556-557`, `executors.mjs:271-274`) |
| Boundary violation | **no** | Held for the owner, as today (`controller.mjs:381-382`) |
| `quota`, `auth`, `spawn-failed`, `unavailable`, admission blocked, `lost` | **no** | Account wait or fallback, as today; not a quality signal |
| Credits or billing limit | **no** | Account wait (`executors.mjs:278-280`); never a reason to try a pricier model |

Steps:

- **First poor-quality result on a tier:** the next attempt goes to another eligible candidate on the **same** tier if there is one (a sidestep, like today's `lastFailedExecutor`). The failed candidate is the `(kind, model)` of the newest entry in `inputs.escalation.priorAttempts` (section 9). Otherwise, it stays.
- **Second poor-quality result on the same tier:** move up one tier. For R2 steps, move up after the **first**.
- **Verifier:** two unusable reviews in a row (`invalid-result`, `exit-without-result`, `timeout`) move the verifier up one tier. A rejection is a useful review, not a verifier failure.
- **At the top tier**, the existing rules apply unchanged: backoff retries and repair rounds, with no cap unless the owner declared one ([AW-002](../DECISIONS.md#aw-002---campaigns-have-no-capacity-limits-by-default)).

The escalation state is derived from the task's finished operations and their receipts, never stored separately. A restart cannot lose or double it.

## 6. Owner pin

- `routing.pin` may set `implementer`, `verifier` or both, each as `{ "kind", "model" }` (one candidate) or `{ "tier": n }` (any candidate of that tier).
- The pin must name a declared candidate or tier. Registration rejects anything else. A pin never adds a model, a provider or a permission.
- Eligibility filters 1 to 6 still apply. A pinned candidate that is waiting makes the step wait for it. It does not fall back, because a pin means "only this". The wait shows as a normal provider wait (ADAPTIVE_SCHEDULER.md §6).
- A model pin turns off escalation for that stage. A tier pin keeps sidesteps within the tier.
- The verifier independence rules (section 4.3) still apply. A verifier pin equal to the implementer pin is allowed and recorded as `fresh-session-same-model`.
- Changing a pin is a routing amendment (section 4.1).
- A campaign without `routing` is in effect pinned to its declared chain: today's behaviour.

## 7. The role catalog comes from Engineering Platform

- The supervisor reads `registry/agents.json` from the configured governance root, through the same root rules as the project registry (`governance.mjs:28-39`). A new `roleCatalog(root)` returns the role ids and their `independent_from` lists. Nothing is copied into AIWorks.
- The catalog is read at registration (to validate task `role` values) and at dispatch (to fill the receipt). The receipt records the catalog file's blob digest, so a later EP change is visible in the record.
- If a task declares a `role` and the catalog is missing or lacks that id, registration fails closed. This is the same rule as for the project registry (`campaign.mjs:230-237`, `campaign.mjs:259-264`). Tasks without `role` do not need the catalog.
- EP's catalog has no schema in `schemas/` that this design relies on (whether one exists is **unknown** here). AIWorks checks the shape it reads: `roles[]` with string `id`, and optional string-array `independent_from`. Proposed to EP as text, not opened from here: *add `schemas/agents.schema.json` for `registry/agents.json`, so consumers validate the catalog with EP's own schema, as AIWorks does for project contracts (`campaign.mjs:12-22`).* AIWorks does not wait for it.
- Mapping to packet roles stays as today (`implementer`, `verification`). Using `security-review` and `browser-review` packets is not part of this design.

## 8. Baseline before any saving is claimed

No routing cohort runs, and no saving is claimed, before a baseline is recorded from the existing store with the method below.

### 8.1 How it is measured

A read-only command, `supervisor baseline --data <dir> [--since <date>]`. It opens the store read-only (`store.mjs:93-96`; a store of another version is refused, `store.mjs:108`), makes no model, network or GitHub call, and prints a JSON report and a short table.

It reads these existing fields:

| Store field | Used for |
| --- | --- |
| `operations.kind`, `seq`, `task_id`, `campaign_id`, `executor_kind`, `state`, `created_at`, `updated_at` | Attempts per task and stage, run time |
| `operations.outcome.class`, `.refunded`, `.detail`, `.value.result`, `.value.verdict`, `.value.headSha`, `.value.findings[].severity` | Quality: accepted, rejected, unusable; which head was accepted; refunds excluded |
| `operations.outcome.receipt.costUsd`, `.usage.{input,output,cacheRead,cacheCreation,inputIncludesCacheRead}`, `.numTurns`, `.measured` | Native cost; unknown counts |
| `operations.target_sha` | Links a verify run to the implement attempt that produced the head |
| `tasks.state`, `attempts`, `repair_rounds`, `failures`, `verified_sha` | Accepted outcomes, repair rounds, retry churn by class |
| `campaigns.declaration` (executor, tasks), `cost_usd`, `runs_used` | Task class indicators (section 3), current models |
| `journal` `executor-amended` (`from`, `to`) | Which model was declared when an older operation ran (`api.mjs:44-46`) |
| `journal` `operation-finished`, `executor-fallback`, `executor-unavailable`, `run-refunded` | Verdicts, blocking counts, fallbacks, provider waits |
| `coordinator_runs.cost_usd` | Planning overhead, per host, not per task |

### 8.2 What it reports

For each task class (stage x risk x complexity) and each provider and model:

- accepted outcomes; implement attempts and verify runs per accepted outcome;
- first-pass acceptance (the first implement attempt's head was accepted with no repair);
- repair rounds per accepted outcome; retries by failure class;
- run time per attempt, and time from the first operation to verification;
- provider wait episodes and fallbacks (from the journal);
- per accepted outcome: reported dollars, tokens by provider, and the **number of runs with unknown cost**. Totals are kept per unit and never added across units;
- coordinator dollars per period, as overhead.

### 8.3 What it cannot measure

- **Dollars for Codex, Cursor and AGY.** They report none (section 2.3). Their cost stays unknown, and so does any total that includes them.
- **Cursor usage of any kind.** It reports nothing.
- **What the owner actually pays.** Whether Claude's reported dollars are billed, or are a subscription equivalent, is unknown. The report says "reported", never "spent".
- **The model of an operation with certainty.** It is not stored today (section 2.3). It is inferred from the declaration and executor amendments; Codex without a declared model is "CLI default" (unknown). Slice R2 records it from then on.
- **Defects found after acceptance.** Reverts, follow-up fixes and owner review comments after a PR is published are in GitHub, not in the store.
- **Missed defects by a verifier.** The store shows only usable reviews.
- **Exact provider wait duration.** The journal records when a wait starts. The end is approximated by the next dispatch of that task and labelled approximate.
- **History before 2026-10-12.** The AIWorks store started fresh at the split ([AW-007](../DECISIONS.md#aw-007---aiworks-is-a-standalone-product-separate-from-engineering-platform)); how many runs it holds now is unknown to this document. The archived earlier store (`D:\Backups\handson-split`) may be read by the same tool if its store version matches; whether it does is unknown.

### 8.4 When a saving may be claimed

- The baseline report is recorded first, with its window and its store identity (`store.mjs:110-116`).
- A cohort then runs with `routing.mode: "auto"` (slice R7). The same report is produced for it.
- A difference is claimed only per class, and only where each side has **at least 10 accepted outcomes**.
- Fewer runs, fewer repairs or shorter time per accepted outcome may be claimed in those units. A dollar saving may be claimed only over runs with reported dollars, and the claim states the share of runs with unknown cost.
- If quality drops (lower first-pass acceptance, or more repairs) in any class, routing stays off for that class until the floor is raised. Cost never buys lower quality.

## 9. The routing receipt

Every operation gets an immutable, versioned receipt. It is written in the same transaction that inserts the operation (`controller.mjs:742-751`), in a new additive `operations.routing` JSON column. It is added the same way `executor_kind` was (`store.mjs:118-122`), so the store version does not change.

```json
{
  "version": 1,
  "policy": "routing-policy/1",
  "mode": "auto",
  "inputs": {
    "stage": "implement",
    "task": { "deliverable": "commit", "web": false, "role": "backend-engineer", "references": 7, "acceptance": 5,
      "dependsOn": 1, "requiresMergedDependencies": false, "writes": ["src/api/"], "declared": { "risk": null, "complexity": null } },
    "sensitivePaths": ["src/supervisor/"],
    "catalog": { "digest": "84f078e6...", "independentFrom": null },
    "candidates": [ { "kind": "claude-cli", "model": "sonnet", "tier": 2, "researchOnly": false }, "..." ],
    "candidatesDigest": "sha256 of the declared candidates",
    "platform": "win32",
    "hostFacts": [ { "kind": "claude-cli", "cliConfigured": true, "hostUnavailable": null, "wait": null },
      { "kind": "codex-cli", "cliConfigured": true, "hostUnavailable": null, "wait": null } ],
    "history": [ { "kind": "claude-cli", "model": "sonnet", "class": "implement/R0/C2", "attempts": 12, "accepted": 9,
      "cost": { "unit": "usd-reported", "mean": 0.84, "known": 12, "unknown": 0 }, "medianMs": 610000,
      "window": { "fromOp": "...", "toOp": "...", "to": 1760000000000 } },
      { "kind": "codex-cli", "model": "gpt-6-astra", "class": "verify/R0/C2", "attempts": 8, "accepted": 8,
      "cost": { "unit": "tokens", "mean": null, "known": 0, "unknown": 8 }, "medianMs": 240000, "window": { "...": "..." } } ],
    "escalation": { "tier": 2, "qualityFailuresOnTier": 0, "priorAttempts": [ { "op": "...", "kind": "claude-cli", "model": "sonnet",
      "class": "result", "terminal": "rejected", "denied": false, "tier": 2 } ] },
    "pin": null,
    "implementerSessions": [],
    "headImplementer": null
  },
  "decision": {
    "indicators": { "risk": "R0", "complexity": "C2" },
    "floor": 2,
    "eligibility": [ { "kind": "codex-cli", "model": "gpt-6-astra", "role": "implementer", "reasons": ["role-unsupported"] },
      { "kind": "codex-cli", "model": "gpt-6-astra", "role": "verification", "reasons": [] }, "..." ],
    "verifierProjection": [ { "implementer": { "kind": "claude-cli", "model": "sonnet" },
      "verifier": { "kind": "codex-cli", "model": "gpt-6-astra", "tier": 3 }, "independence": "different-model",
      "u": { "unit": "tokens", "mean": null } }, "..." ],
    "chosen": { "kind": "claude-cli", "model": "sonnet", "tier": 2 },
    "basis": "tier-walk",
    "reason": "lowest tier with <= 2 expected attempts; E unknown: projected verifier reports tokens",
    "independence": null
  },
  "inputsDigest": "sha256 of canonical inputs"
}
```

**Reproducible from the receipt alone.** `inputs` is the complete argument of `route()`. `route(inputs)` is a pure function of it: no clock, no store, no host check, no other argument. Host facts (CLI configured, probe result, waits) enter as `hostFacts`, one entry per provider kind, and history enters as aggregated numbers. Every value a decision rule reads is in `inputs`:

- `platform`, each candidate's `researchOnly`, and the task's `deliverable` and `web` are everything the pure filters 1, 2 and 4 read (section 4.2). So the router computes eligibility for **both** roles from the receipt. It does not rely on a stored answer for one role.
- `hostFacts` holds filters 3, 5 and 6 as observed at dispatch. They apply to both roles.
- `history` holds the rows of the step's own class. For an implement step, it also holds the verify-class rows (`verify/<risk>/<complexity>`) of every candidate. The verifier projection (section 4.4) reads them.

- `escalation.priorAttempts` lists the task's earlier finished attempts of the same stage, newest first. Each entry carries the attempt's `kind` and `model`, its outcome `class` and `terminal`, whether it was a denial (`denied`, the same test as `controller.mjs:557`), and its tier. The model comes from that attempt's own receipt (`decision.chosen.model`). An operation recorded before slice R2 has no receipt, so its `model` is `null` and its `kind` is its `executor_kind`. The section 5.4 sidestep and static mode's `lastFailedExecutor` avoidance (`controller.mjs:549-561`, `controller.mjs:568`, `controller.mjs:586`) both read the newest entry, so both replay from the receipt.
- `implementerSessions` lists the session ids of the implement attempts that produced the head under review. `headImplementer` is `{ "session", "kind", "model" }` of the attempt that produced that head, taken the same way; it is `null` for implement steps. Verifier rule 1 (section 4.3) reads the sessions; rule 4 reads `headImplementer.kind` and `headImplementer.model`.

Replaying any receipt must give the same `decision`, including `decision.eligibility` and `decision.verifierProjection`; a test checks that for every operation in the routing suite. For an implement step, replay recomputes `v(m)` and `u(v(m))` for every candidate from `inputs` alone, so a ranking that depends on the verifier (section 5.2) replays exactly. A change of policy is a new `policy` id, and old receipts replay with the old policy.

**Restart and replay.**

- A recorded operation that is launched again after a crash reuses its run directory and its `spec.json` argv, which already holds the model (`controller.mjs:733-736`, `controller.mjs:235-249`). The router is not called again, so the choice cannot change.
- Runs are counted once at insert (`controller.mjs:750`). Cost is added once when the result is applied; a second apply is ignored (`controller.mjs:311`, `controller.mjs:328`). Routing adds no counter, so nothing is charged twice.
- A fallback after quota or auth is a new operation with its own receipt that names the failed one in `escalation.priorAttempts`.

**Quota and auth do not spin.** Those outcomes write a wait (filter 6) and are not quality signals. When no candidate is eligible, the existing timed wait or B2 blocker applies (`controller.mjs:619-626`, `controller.mjs:394-397`).

**The model reaches the worker** through the existing `executor.model` argument: Claude `claude.mjs:133`, Codex and Cursor `executors.mjs:182`, AGY `agy.mjs:107`. The router passes the provider entry with the chosen model. An unknown model name fails the run; that failure becomes an `unavailable` wait for that **candidate** only, untimed until a recheck, so it does not loop.

**What the owner sees** (slice R6): per accepted step, "Model: Sonnet (standard). Cost: $0.84 reported + 1 check run with unknown cost." Per work program: dollars reported, tokens by provider, runs with unknown cost, and a short reason when a step moved up ("moved to the strongest model after two rejected attempts"). The raw receipt is a drill-down. Wording follows [D9](../PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates) (English) and the #11 work view.

## 10. Synthetic evaluation table

These cases become the table-driven tests of slice R4. Candidates as in section 4.1, plus `agy-cli` (tier 2) for web. "History" is synthetic.

| # | Job | Indicators | Floor | First choice | Escalation in the test |
| --- | --- | --- | --- | --- | --- |
| 1 | Fix a typo in one doc (commit, `writes: ["docs/X.md"]`, 2 references, 2 criteria) | R0, C1 | impl 1, verify 2 | Haiku implements (cold start); Sonnet checks | Two rejections on tier 1 → Sonnet implements the next repair |
| 2 | New API endpoint (commit, `writes: ["src/api/"]`, 7 references, 5 criteria) | R0, C2 | impl 2, verify 2 | Sonnet; with history Sonnet `â`=0.75 against Opus 0.85 at higher cost → Sonnet (dollar rule) | One `invalid-result` → sidestep impossible (one tier-2 candidate) → stays; second → Opus |
| 3 | Cross-cutting refactor (commit, no `writes`, 14 references, 8 criteria, 3 dependencies, merged dependencies) | R1, C3 (6 points) | impl 3, verify 3 | Opus implements; verifier prefers Codex (different model, C3) | Codex unusable twice → verifier tier already top; backoff only |
| 4 | Browser acceptance (report, `web`) | R1, C1 | impl 2, verify 2 | AGY; if AGY waits, Claude with the browser (`executors.mjs:12-14`) | AGY quota → Claude browser; **not** escalation; receipt reason `account-wait` |
| 5 | Supervisor change (commit, `writes: ["src/supervisor/"]`, role `backend-engineer`) | R2 | impl 3, verify 3 | Opus implements; Codex verifies (different model); the verifier role `verification-agent` lists `backend-engineer` in `independent_from` | One rejection: R2 escalates on the first failure but Opus is already top tier; Codex cannot commit on Windows (`role-unsupported`, `executors.mjs:132`), so Opus repairs |
| 6 | Codex worker hits a sandbox denial | any | — | Codex | **No** escalation and no provider change; same order next attempt |
| 7 | Claude usage limit mid-campaign | any | — | Opus | Account wait; next eligible candidate at or above the floor; Opus resumes after the reset |
| 8 | Owner pins `implementer: claude-cli/opus` | R0, C1 | pinned | Opus | No escalation; when Opus's account waits, the step waits |
| 9 | Campaign without `routing` | any | — | First provider in the declared chain, as today | Today's `lastFailedExecutor` rotation, unchanged |
| 10 | Verify step after implementer session S1 | any | 2 | Fresh session S2 ≠ S1; only declared candidates | A test forcing an equal id fails |
| 11 | Implement step, two candidates in dollars: `m1` with `u` = 1, `â` = 0.5; `m2` with `u` = 2, `â` = 0.8; 5+ attempts each in both classes | R0, C1 | impl 1, verify 2 | Verify-class history gives `v(m1)` and `v(m2)` with `u(v)` = 0 → `m1` (`E` 2 against 2.5); the same receipt with only the verify-class rows changed so `u(v)` = 10 → `m2` (`E` 22 against 15) | Replay of both receipts gives the same `chosen` and `verifierProjection`; on Windows, a Codex candidate is `role-unsupported` for implementer but eligible as verifier, recomputed from `platform` |

## 11. Decisions taken here (not owner-reserved)

- **D8 (model choice):** automatic, deterministic routing by role, risk, complexity and measured outcome, among the models the campaign declares, with an optional owner pin. Unknown billing stays unknown. This follows the plan's proposed resolution (§8).
- Opt-in per campaign through `routing`. Without it, behaviour is unchanged.
- Tiers are the owner's declared cost order. Units are never converted into each other.
- Escalation only on poor-quality evidence. Never on a denial, a limit, a login problem or a host failure.
- A different verifier model for risky work is a preference. Fresh session and authorized candidates are hard rules.
- The receipt is immutable, versioned, stored with the operation, and replayable without the store.
- The role catalog is read from the EP governance checkout, never copied.
- No saving is claimed before the baseline (section 8.4).

## 12. Owner-reserved questions

None of these re-opens D1, D3, D5 or D9.

| # | Question | Recommended answer | What it unblocks |
| --- | --- | --- | --- |
| Q1 | Which models may each of the owner's accounts use, and is any account billed per use rather than a flat plan? Accounts and spending are the owner's ([Constitution §2](https://github.com/netbka/engineering-platform/blob/main/docs/CONSTITUTION.md#2-owner-role)), and a different model on a pay-per-use account changes spending. This document cannot see the accounts (unknown). | Allow routing among the models of the providers already in use, on the same logins, where the plan is flat. On any pay-per-use account, keep today's single model unless the campaign also declares `maxCostUsd`. | Declarations with several candidates per provider for the cohort (R7). R1 to R6 do not wait. |
| Q2 | May routing run on the live HomePc runtime, after R1 to R5 are merged, reviewed on their exact heads and deployed by the documented upgrade? Changing what the live runtime does is a production change agents may not make ([AGENTS.md](../../AGENTS.md#agents-must-not)). | Yes, for one cohort of AIWorks documentation and design campaigns first, compared with the baseline (section 8.4) before wider use. | R7: the first measured comparison. |

Waiting on decisions already open elsewhere (not asked again here):

- Account grouping of waits is ADAPTIVE_SCHEDULER.md Q1 (slice S1). Routing uses its answer.
- Fully local projects wait for **D2** and **D4**. The router does not depend on GitHub; it only needs a registered project and its declaration.
- Auto Release (**D5-gate**, #13) and Telegram delivery (#1) are not touched. `release-agent` work is not routed until #13 is authorized.

Engineering Platform: no EP change is required. The schema for `registry/agents.json` (section 7) is an optional proposal, given here as text.

## 13. Implementation slices

Every slice is one reviewable PR. A slice that changes `src/supervisor` needs an independent review approving its exact head before merge ([AGENTS.md](../../AGENTS.md#changing-the-supervisor)). Merged is not deployed: nothing reaches HomePc before R7. Every slice runs `npm run check`. All tests use disposable stores, disposable git repositories and the synthetic executables in `tests/supervisor/fixtures/`, as `tests/supervisor/helpers.mjs` does. They make no model, network or GitHub call. `fake-claude.mjs` already records each call's arguments, including `--model` (`tests/supervisor/fixtures/fake-claude.mjs:19-21`).

Slices that edit `controller.mjs`, `campaign.mjs` or `api.mjs` are sequenced with the scheduler slices and F2-DUPLICATE that edit the same files: one at a time, never in parallel.

**R1. Baseline report** (read-only)

- Outcome: `supervisor baseline` prints the section 8.2 report from any store, read-only.
- Files: new `src/supervisor/baseline.mjs`, `src/supervisor/cli.mjs` (subcommand), `docs/SUPERVISOR.md` (short section), new `tests/supervisor/baseline.test.mjs`.
- Tests: a synthetic store with Claude, Codex, Cursor and AGY operations. Unknown cost is counted as unknown and never as zero. Units are never summed together. Refunded runs are excluded. The model is inferred across an `executor-amended` entry. The store file is byte-identical after the run.
- Acceptance: makes no write, model, network or GitHub call; refuses another store version.
- Depends on: nothing. Waits for: nothing.

**R2. Model and receipt on every operation** (behaviour unchanged)

- Outcome: each new operation stores a `routing` receipt (`mode: "static"`) that records today's choice, its eligibility reasons and the model. The `operation-recorded` journal entry names the model.
- Files: `src/supervisor/store.mjs` (additive `routing` column), new `src/supervisor/router.mjs` (static mode, receipt builder, `route`), `src/supervisor/controller.mjs` (`executorChoice` returns the receipt; dispatch stores it), new `tests/supervisor/routing-receipt.test.mjs`.
- Tests: for every operation of a chain campaign with fallback, `route(receipt.inputs)` equals `receipt.decision`, and that decision equals the executor actually run. The receipt holds `platform`, each candidate's `researchOnly` and the `hostFacts` (section 9), and `decision.eligibility` lists both roles; a test runs the same receipt with `platform` changed from `win32` to `linux` and checks that only Codex's commit-role reason changes. This includes a retry after a task-level failure, where static mode must move the failed provider behind the others from `inputs.escalation.priorAttempts` alone, and a retry after a denial, which must keep the declared order. `route` takes `inputs` as its only argument. A crash after record (`AIWORKS_FAULT=after-record`) relaunches with the same receipt and model.
- Acceptance: the whole existing suite passes unchanged; old stores open, and operations without a receipt read as `null`.
- Depends on: nothing. Waits for: nothing.

**R3. Role catalog and declaration fields**

- Outcome: `routing` (candidates, sensitive paths, pin) and task `role` / `routing.risk` / `routing.complexity` validate. Roles are checked against EP `registry/agents.json`. Routing amendments follow the executor rule.
- Files: `src/supervisor/governance.mjs` (`roleCatalog`), `src/supervisor/campaign.mjs`, `src/supervisor/api.mjs` (routing amendment), `tests/fixtures/governance/registry/agents.json` (synthetic roles for tests), `tests/supervisor/campaign-registry.test.mjs`, `docs/SUPERVISOR.md`.
- Tests: an unknown role fails closed; a pin outside the candidates is rejected; a candidate kind outside `executor.providers` is rejected; declarations without the new keys validate and digest exactly as before; amending `routing` on a running campaign is refused.
- Acceptance: no campaign in `campaigns/` changes its scope digest.
- Depends on: F2-DUPLICATE (owner of `campaign.mjs` and `api.mjs` for #5); scheduler S3 for `writes` (until then risk treats every commit task as R1 or above). Waits for: nothing.

**R4. Router policy** (pure function)

- Outcome: indicators, filters, floors, history aggregation, ranking, escalation, pin and verifier independence, as `routing-policy/1`.
- Files: `src/supervisor/router.mjs`, new `tests/supervisor/router.test.mjs`.
- Tests: the section 10 table, case by case; property tests that a choice is always a declared candidate, never below the floor unless `floor-capped`, never escalated by a denial, quota, auth or host outcome, and never a verifier session equal to an implementer session; a sidestep and a different-model verifier preference that change when only `priorAttempts[0].kind`/`model` or `headImplementer.kind`/`model` change; an implement choice that flips when only the verify-class `history` rows change (section 10, case 11), with `verifierProjection` recomputed and the replay equal; `E` unknown, never zero, when a projected verifier has no known cost or another unit; replay of every generated receipt.
- Acceptance: the router reads no clock, store or host state; coverage of every reason code.
- Depends on: R2, R3. Waits for: nothing.

**R5. Use the router at dispatch**

- Outcome: campaigns with `routing.mode: "auto"` dispatch with the router's model; escalation follows recorded outcomes; filter 5 runs before the choice; an unknown model makes a candidate wait.
- Files: `src/supervisor/controller.mjs` (`executorChoice`, `transition` fallback, dispatch), `src/supervisor/adapters/executors.mjs` (classify an unknown-model failure as `unavailable`), `tests/supervisor/fixtures/fake-claude.mjs` (scenario per model), new `tests/supervisor/routing.test.mjs`.
- Tests: tier-1 start on a trivial task and tier-3 on a supervisor task (`--model` read from the fake's calls); two rejections move the repair up; a denial does not move it; a quota moves to the next eligible candidate and back after the reset; a pin holds through a wait; a restart keeps the chosen model; no model call on idle ticks (call count unchanged over idle ticks).
- Acceptance: with no `routing`, the existing executor, resilience and restart suites pass unchanged.
- Depends on: R4; scheduler S1 recommended (with S1 absent it reads `executor_waits`). Waits for: nothing.

**R6. Cost and routing in status and the project work view**

- Outcome: per accepted step and per work program, the owner sees model, tier, reported cost by unit, unknown-cost run count and the reason for any move up.
- Files: `src/supervisor/api.mjs` (status fields), `src/dashboard/supervisor.mjs`, `src/dashboard/public/dashboard.js`, `tests/supervisor/status.test.mjs`, `tests/dashboard/`.
- Tests: totals are never summed across units; unknown is shown as unknown; no worker text appears in a reason.
- Acceptance: blind owner review per [UX-002](https://github.com/netbka/engineering-platform/blob/main/docs/EXPERIENCE_REVIEW.md).
- Depends on: R5; follows the #11 work view design and its file owner. Waits for: nothing owner-reserved.

**R7. Cohort and live enablement** (runbook and declarations, no code)

- Outcome: a baseline report is recorded, one cohort runs with routing on HomePc, and the comparison is published per section 8.4.
- Files: `docs/SUPERVISOR.md` (enable and roll back: remove `routing` with an amendment), `docs/STATUS.md`, one cohort declaration in `campaigns/`.
- Tests: the full suite at the deployed SHA; `supervisor baseline` before and after; status before and after the upgrade ([AGENTS.md](../../AGENTS.md#upgrading-the-live-runtime)).
- Acceptance: observed on HomePc, and labelled verified only there: chosen models match receipts, no run was charged twice, quota waits did not spin, and any claim meets section 8.4.
- Depends on: R1 to R5 merged and deployed (R6 recommended).
- Waits for: **owner** Q1 and Q2.
