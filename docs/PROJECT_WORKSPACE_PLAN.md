# AIWorks - Project-first owner workspace and adaptive delivery plan

**Privacy boundary:** this is a design proposal, not a live installation record. Campaign declarations and approval records stay private under [AW-009](DECISIONS.md#aw-009---public-commits-contain-no-installation-data). Any proposal to publish declarations through source branches or pull requests is superseded. Merged executable code, explicit owner authorization, scope binding and independent verification remain required.

**Status:** PLANNING ONLY. Owner approved four product-direction decisions on 2026-10-12 (recorded in section 8). These are design requirements, **not** authorization to change the running supervisor, merge/deploy, add credentials or override AW-001..AW-007. Execution/release permissions remain governed by the applicable, separately reviewed authorization gates.

**Prepared:** 2026-10-12. Repository basis: `example-org/aiworks` main at `<revision>`, and the linked `example-org/governance` main. Every "current" statement below describes inspected repository code/docs as of this revision; it is not a new live-host check.

**Tracking:** This planning PR plus Workspace #7, #8, #9, #10, #11, and #13 (opt-in automatic release); existing #1..#6. This is the one implementation-roadmap document for this redesign. GitHub issues/PRs remain the live work-state authority.

## 1. Product, stated from the owner's job

**One sentence:** AIWorks runs and supervises AI-assisted delivery across the owner's local projects - with or without GitHub and even when the starting folder has no Git metadata. Connect a folder, specify an outcome or existing work, approve one scoped work program, then let AIWorks plan, dispatch, independently check, adapt and continue. An optional separately authorized release mode can complete a project's delivery when its verified release gates permit it.

**The job:** Connect projects, authorize an outcome, let the supervisor route and independently check bounded work, and understand deliveries and blockers without monitoring individual terminals.

AIWorks is **not** a Git hosting provider, chat-first general assistant, portfolio governance registry, multi-user cloud SaaS, remote-access system or generic autonomous backlog claimer. It **will** provide an opt-in release workflow through a separately governed adapter, without replacing the project-specific release authority.

**Value hierarchy:**
1. *Start a useful outcome* from a local project and a human instruction, issue, PR or plan.
2. *Keep it moving* after explicit owner registration: planning, a dependency-aware task graph, eligible workers, separate checking, retry/recovery and trustworthy outcomes.
3. *Show the outcome* by project and request the owner's attention only when necessary.
4. *Optimize execution* for accepted results, independence, elapsed time and cost/usage - not for worker counts, token counts or an attractive dashboard.

A **project** is the primary product object. A **campaign** is one authorized work program within a project. A **task** is a deliverable in that program. An **agent** is a short-lived role execution, not an object the owner must manually administer.

**Acceptance definition:** The owner can connect at least two projects, including one ordinary local folder with no GitHub remote, launch a permitted work program for either, monitor both and inspect independently verified outcomes. GitHub-backed work shows real PR/merge state; local-only work shows a local revision/evidence ledger and **never fabricates a PR**. The system continues within the approved outcome envelope without another "continue" prompt. It must never imply that "PR published" means "merged", "deployed" or "accepted".

## 2. Keep the existing machine - fix the owner-facing workflow

### Repository observations (do not reimplement)

| Present and useful | Limitation requiring work |
| --- | --- |
| Deterministic supervisor with SQLite operations, fencing, restart recovery, worker/verifier separation (`src/supervisor/`) | The owner must prepare `campaigns/*.json` and register through the CLI. There is no dashboard create-project/create-campaign route. |
| Configured local Git checkouts and isolated worktrees (`README.md`, `src/supervisor/adapters/git.mjs`) | Paths/repos are manually registered in local `config.json`; no folder-first onboarding. GitHub remote and governance GitHub-repository match are currently required for campaign admission. Fully local/no-Git support needs a new scoped local project contract and adapter. |
| Coordinator with durable owner-message receipts and read-only research (`src/supervisor/coordinator.mjs`) | It proposes work but does not turn an approved plan into a registered execution program. |
| Task DAG, declarative executor chain, project governance lookup (`src/supervisor/campaign.mjs`, `controller.mjs`) | `limits.slots` permits only `1`; `schedule()` exits when one operation is open. No adaptive parallelism or fair cross-project capacity controller. |
| Explicit Claude/Codex/Cursor models, AGY/browser adapter, independent verifier, provider fallback and some cost receipts | Provider order/model choices are declared per campaign, not quality/cost-selected per task/role. Some costs remain unreported; account cooldown scope across campaigns is a risk (#5). |
| Dashboard with owner-attention reconciliation, GitHub issue/PR metadata, commands, receipts and activity (`src/dashboard/`) | Global sections are Overview / Plans / Issues & PRs / Agents / Messages / Activity; Overview mixes every concern. A project is not the main navigation context. |
| governance inherited governance and AIWorks-local `AGENTS.md`, decisions and constitution | Inheritance is already correct; **do not fork governance policies or duplicate generic documentation here**. |

Current GitHub snapshot: zero open PRs and six pre-existing open issues when this planning work began (#1..#6). Archived `governance-archive` PRs #126 and #139 are **closed and unmerged**; issue #6 tracks their selective port. The current branch's planning-only PR should not race with those runtime files or with the previously reserved audit-fix work in #5.

### Existing authority and constraints (non-negotiable for this plan)

- [AIWorks AGENTS.md](../AGENTS.md), [Product Constitution](PRODUCT_CONSTITUTION.md), [Decisions AW-001..AW-007](DECISIONS.md), [Supervisor](SUPERVISOR.md), [Worker Context Lifecycle](WORKER_CONTEXT_LIFECYCLE.md).
- governance Constitution, Agent Operating Model, Continuation, Owner Intervention, Governance Inheritance, AGENT-001, Delivery Practices, Experience Review / UX-002, Behavioral Interaction / UX-001.
- governance owns portfolio policies, project registry, role catalog and project-contract schemas. AIWorks reads the governance checkout, never writes it as a side effect of project selection. `registry/projects/aiworks.json` already registers AIWorks with `ui` and `worker` capabilities. **Gap:** the existing GitHub-identified registry/target contract cannot express an ordinary folder without a remote. Support requires a reviewed governance-compatible local project identity/contract and explicit project governance inheritance, not skipping governance checks.
- AW-001 currently prohibits supervisor merges, deployments and provider-resource mutations. The owner now wants a **separate, opt-in Auto Release mode** (#13), but this new direction does **not** amend AW-001 or itself grant runtime deployment rights. A narrowly reviewed AW decision, scoped release capability and required governance release authorization must precede enablement. AW-003: local-only dashboard; AW-006: no combined dashboard across machines. "Several projects" means several local projects on this machine.
- AW-002: no default run/cost ceilings. Safety limits for actual host/provider concurrency are not equivalent to a monetary/run cap. All user-declared budgets remain honored.
- AW-004: the coordinator stays read-only; it proposes plans but cannot itself register/dispatch. AW-005: the **initial authorized campaign declaration** and executable code come from merged AIWorks `main`; UI convenience cannot bypass either gate. Approved autonomous subtask expansion **inside that immutable authorization envelope** requires a separately reviewed, versioned DAG amendment design; it must not execute unmerged code or silently widen scope.
- One accountable Task Controller per parent outcome; fresh independent verifier; durable bounded packets; no idle model calls, credential copies, peer-to-peer orchestration or invented completion evidence.

## 3. Product vocabulary and state model


### 3.1 Project connection - GitHub optional (owner approved D1, 2026-10-12)

A **project is a local directory**, not a GitHub repository. Support three input states:

| Source type | GitHub remote | Native Git in owner folder | Work and evidence |
| --- | --- | --- | --- |
| Connected repository | Optional but present | Yes | Existing GitHub PR/issue integration, isolated worktrees, real merge state. |
| Local Git | Absent | Yes | Local commit/revision graph, isolated worktrees, local review and independent evidence; no pretend remote PR. |
| Plain local folder | Absent | Absent | Owner-selected source folder; AIWorks manages its own isolated, revisioned mirror/workspaces **outside the source**, with an explicit apply/publish operation and reversible snapshot/backup. Never run `git init` or overwrite user files silently. |

**Governance gap:** Today project admission depends on a governance registry entry keyed by GitHub repository. Before local-only dispatch, review and extend the governance contract's project-identity/registration contract to authorize a local project by stable owner-scoped ID and approved local authority pointers. **Prefer a one-time governance contract extension with an owner-authorized local project registry overlay** validated against inherited governance policies, so adding each ordinary folder does not require a new GitHub PR. The local overlay may never waive a governance policy or overwrite the governance checkout. Do not bypass governance because a remote does not exist.

A local connection references:
- stable owner-scoped project ID, source kind, canonical local root, selected source revision/snapshot, isolated worktree or managed mirror root, machine identity and optional GitHub identity/base branch;
- verified capability flags and status (Not connected / Needs setup / Ready / Temporarily unavailable), governance binding, last preflight and precise recovery action;
- no credentials or secret values. Paths may be displayed **only** inside this owner's local-only UI subject to existing containment; no untrusted worker output or public exposure.

**Connection flow:** Pick directory -> inspect Git if present -> choose `GitHub` / `Local Git` / `Local folder` -> verify source and permissions -> establish approved local governance identity -> configure isolated working state -> save -> open project. Do not require a remote, `gh` login or Internet access **for project connection itself**. Online AI CLIs may still need their own provider connectivity; local project support is **not** a claim that all models run offline.

**Local-folder write contract:** Use a revisioned snapshot or internal managed Git mirror as the agent's source-of-truth staging surface, not an uncontrolled writable copy of the original. Bind a baseline hash/manifest before task dispatch; agents only mutate isolated staged workspaces. Before applying results to the owner's source, check for changes/conflicts, owner-selected output policy and reversibility; preserve original files/backups, refuse unresolved overlaps and record a verifiable local result. Symlinks, junctions, nested repositories, file permissions, case-folding on Windows, ignored/secret-like paths, oversized projects, binary changes, deletes and external file mutation must have explicit preflight and tests. No automatic whole-folder recursive command or secret copying.

Connection does not itself authorize execution or release. Require tests across GitHub, local Git and non-Git sources with two concurrent projects. Keep the governance contract's role, policy, ownership and evidence constraints for all three modes.


### 3.2 Work request - one authorization, autonomous execution inside its scope (owner approved D3)

Required: project identity/source kind, request type (`goal`, `issue`, `pr`, `plan`, or `local task`), human outcome, optional issue/PR reference when GitHub exists, pinned initial revision, acceptance intent, authorized write/release boundaries and explicit scope version. Existing issue/PR selection is **optional**; a local folder can start directly from a goal or a local task/plan file.

**Plan only:** read-only planning/report, without changing the owner's files.

**Plan and execute:** coordinator researches and proposes a bounded, independently checkable plan. The owner approves the **outcome envelope once**; AIWorks then chooses, creates, revises, routes and executes internal tasks and repairs **without asking again for each task**. The Task Controller remains accountable for the entire outcome.

The **currently running** supervisor still requires AW-005's merged-main gate. To make a fully local project usable without a GitHub login, first separately review a **narrow AW-005 amendment**: executable supervisor code must remain trusted, reviewed and pinned, while a local-only project may register a signed or equivalently tamper-evident owner-approved campaign record **without GitHub**. This is a proposed gate, not a bypass available today. GitHub-backed campaigns keep the current main-declaration route. Plan a **versioned autonomous task-graph amendment** within each approved envelope, with durable audit/admission/fencing, rather than a new approval or PR for each child. No change can widen project files, capabilities, permissions, destination, cost cap (when set), release mode or acceptance goal. Any such scope change pauses only the affected work and asks for new owner authority.

Approval preview remains short:
1. Outcome and verifiable success criteria.
2. Material steps, dependencies and expected independent review.
3. Previous work and duplicate repair conflicts (#5).
4. Exactly what can be modified, which providers/roles can be used, user-declared limits, whether release is `Review only` or `Auto Release`.
5. Approve or revise; technical task packet/JSON available only on drilldown.

GitHub-backed projects can continue an issue/PR, pinning exact head and independent acceptance; local-only projects instead pin their own revision/snapshot. Published/merged and deployed are **not** equivalent. For a source without GitHub, the result is a local verified revision with an explicit apply/release step, not a fictitious PR.


### 3.3 Lifecycle - source-specific delivery evidence

Common: `Draft plan -> Owner authorizes outcome/scope -> Merged runtime and declaration gate -> Registered -> Queued -> Implementing -> Independently verifying -> Delivered candidate`.

GitHub project: `PR published -> PR approved/merged (if authorized) -> release eligibility -> deployed (if authorized) -> independently checked live result`.

Local Git / plain folder: `Local revision + verifier evidence -> staged result -> compare against changed original -> explicitly authorized apply or Auto Release to a configured local target -> post-apply verification`. There is no PR or merge status unless a real GitHub remote is later connected.

The existing **main-only** campaign declaration remains immutable under AW-005. A local-only owner-signed admission alternative and internal versioned task-graph amendment require a formally reviewed narrow AW-005 update preserving trusted reviewed executable code, immutable scope, provenance, audit and fencing. Ordinary in-scope decomposition/repair must not repeatedly interrupt the owner. Invalid or uncertain local file application is never silently replayed after a crash; reconcile the actual target.

Project status distinguishes planned, executing, paused, provider-wait, blocked-owner, blocked-environment, independently verified, delivered candidate, released, accepted, cancelled and **unknown**, with links to source-appropriate evidence. Model output alone is not acceptance.

## 4. Owner information architecture - one primary question per screen

**Global navigation:**
- **Projects:** "Which project shall I open / which project needs attention?" Project list with one status and one action each; prominent **Add project**. Initial empty state starts here.
- **Needs me:** "What actually requires my decision or action across the projects?" Group by project, one decision per row and a direct action link. Provider cooldown is not an owner task.
- **Settings:** "Which local computer, repository connections and worker accounts can AIWorks use?" Machine/CLI readiness and optional policies live here, not on project overview.

**Inside one selected project:**

| Screen / question | First thing visible | Principal action | Hidden under details / separate screen |
| --- | --- | --- | --- |
| **Project / Where are we now?** | One real-world goal, current outcome, one next action; active/waiting truth | **Start work** or **Open current work** | Worker run IDs, provider chains, cost counters |
| **Start work / What should be done?** | Goal input and **Use issue / PR / plan** alternatives; `Plan only` | **Review proposed plan** | JSON declaration, command syntax, framework selection |
| **Review / What will run under my authorization?** | Work outcome, steps, verification, boundaries and existing work conflicts | **Approve work** (or revise) | Full task DAG and per-role executor parameters |
| **Work / What is running, queued or waiting?** | Outcome-oriented steps in simple order, reasons for waits and next dependency | **Open a step**; pause/recheck when applicable | Per-worker sessions and technical journal |
| **Step / What is this agent actually doing?** | Task outcome, role, progress backed by native receipts, verification result | **Send guidance** or see PR/evidence | Logs, attempts, exact model/limits |
| **Results / What is delivered and what remains?** | Delivered steps, accepted commits and open PRs clearly distinct from merged/deployed | **Review result** / **Open PR** | Detailed check evidence |
| **Cost / What did the outcome cost?** | Actual reported project and accepted-outcome consumption, unknown separately | **Inspect breakdown** | Raw token/input/cache and provider receipts |

Keep a maximum of one obvious primary button per state; do not show inactive technical buttons as decoration. Empty, disconnected, no-worker, GitHub-stale, paused, running, blocked and finished states each require explicit truthful copy. Preserve selected project, route, scroll and unsent draft after refresh/back. Navigation shows a short project name rather than campaign IDs; link actual GitHub artifacts when a remote exists and verified local artifacts otherwise. Add a project-scoped `Release mode` entry (Review only / Auto Release), where Auto Release stays unavailable until separately authorized (#13). Existing `Needs you` correctness, lifecycle evidence and receipts in #4 are **reused**, not thrown away.

**Language (owner approved D9):** The UI is **English only for this release**. Keep all labels, errors, actions and empty states in natural, short English; do not allocate a localization framework or Russian copy work. Use normal human outcomes and short verbs. Avoid "pipeline", "fencing", "lease", "slots", "project control plane" or "campaign declaration" at the primary UI level. Technical terms belong in diagnostics. Current interface is English; adding Russian/localization is an open scope choice, not an implied blocker. UX-001/UX-002 reviews apply to the actual interactive local dashboard; start with a blind task-oriented review before approving visual polish.

**Responsive:** 320px first, tablet and desktop; full keyboard navigation, explicit status, focus, screen reader labels, no overflowing status matrices. Do not solve structural problems by adding explanatory paragraphs.

## 5. Execution design - build on the current supervisor


### 5.1 Planning and task breakdown - autonomous inside one approval

- The read-only coordinator reads relevant project authority, local files, known campaigns and, only when configured, GitHub issue/PR metadata. Once the reviewed local project admission adapter exists, a local project must not fail simply because `gh` is missing.
- One accountable Task Controller owns the whole approved outcome. Build the smallest useful dependency graph, with real acceptance criteria. Split only when it adds useful independent work.
- After one owner approval of the **outcome + scope + permissions + project + optional spending caps + release mode**, the controller may add or revise internal child tasks/repair work **inside that envelope**, with a durable versioned plan and verified admission against unchanged boundaries. Do not ask for each child step.
- No accidental backlog claiming, duplicate fixes, role-generated scope expansion, new project, credential exposure or permission grant. If scope needs to expand, seek a separately recorded decision.
- Existing supervisor `campaign.mjs` treats tasks/declaration as immutable; implementation needs a reviewed schema/lease-safe amendment design reusing current SQLite, controller, packet digest, AW-005 and process ownership. A separate **locally authorized admission gate** for GitHub-free projects requires an owner-approved AW-005 amendment; it must not run unreviewed code or unapproved plans. New child-plan versions must be bound to actual merged runtime/code and approved envelope. New task admission must be idempotent after crash/retry.
- An independent verifier remains separate from the implementer. For a local folder use managed staging and local evidence; no GitHub URL is required to prove local work.
- Once registered, continue automatically on independent completion, review finding, provider reset and bounded recovery; route only genuine owner-reserved blockers to the owner.

### 5.2 Adaptive parallelism

Current code: `campaign.mjs` rejects `limits.slots != 1`; `controller.mjs.schedule()` returns when a campaign has an open operation. The proposed work must change admission, not blindly launch processes.

**Runnable capacity** is bounded by independently ready DAG nodes, write-domain/work-key ownership, verified worktree isolation, relevant provider/account availability, process/CPU/memory health, active verifier needs, host safety and explicit owner controls.

**Scheduler behavior:** Start with conservative admission, measure useful completions and resource pressure, increase fanout only when independent work makes that valuable, reduce it on thrash, retry storms or real saturation. Allocate opportunities fairly across projects, and avoid two concurrent writers for the same logical repair (including separate campaigns). Provider cooldowns must not be isolated per campaign if the same actual account is exhausted. A full slot does not mean "agent failed": show the wait reason and next expected automatic action.

Keep the existing SQLite work authority, revision-pinned task packets, lease generations, process containment and idempotent external effects. No parallel implementation/verifier work on the *same* material deliverable without the existing verification sequencing and independence. A controller crash cannot let another project unknowingly duplicate a partially applied write.

**Acceptance gates:** serial-vs-parallel outcome comparison, independent tasks really overlap, conflicts never do; two projects make progress without starvation; crash/restart/timeout/unknown-acceptance and quota recovery do not duplicate an external write. Evidence comes from synthetic/focused tests before workstation rehearsal.

### 5.3 Role/model/cost routing

Use the role catalog already in governance: orchestrator, product/system architect, UX, frontend, backend, DB, security, independent verifier, product reviewer, release and observer. Do **not** duplicate this catalog. Assign a role only when it has a real independent decision, work product or acceptance obligation.

Provider eligibility is determined from **this host's** configured authorized CLIs, permissions, project constraints, role capability and real observed errors. Provider/model *cost and reliability* are attributes of a task stage, not a reason to weaken verification. Proposed decision pipeline:

1. Determine deterministic role/risk/complexity indicators from the approved task and changed boundaries.
2. Filter models/providers by current account authorization, native role/tool support, host support, provider availability and independent-verifier eligibility.
3. Pick the lowest expected *total accepted-outcome cost* for that class (implementation + planning + verification + retries + expected rework), balancing speed and failure risk. Cheap first is not a rule if it causes expensive repeated repairs.
4. Elevate model tier on evidence of insufficient quality or repeated failure; do not escalate for permission denials or leaked/unknown credits.
5. Preserve the chosen executable/model and reason in a versioned receipt so replay/diagnostics are unambiguous. An owner pin overrides ranking within safe permissions.
6. Keep unreported pricing/usage as **unknown**. A subscription-based or provider-limited CLI may not expose a reliable marginal dollar cost; report native units and comparable observed workload without fictional savings.

No idle LLM heartbeat, no provider account rotations outside granted accounts, no default monetary/run caps (AW-002), no new autonomous recurring spend under the governance contract's portfolio rules. Measure baseline and run a small cohort before claiming optimized token or dollar savings.

### 5.4 Owner intervention and results

Reuse #1 for blocker dedup/Telegram recovery, #4 for owner-attention evidence, and #5 for duplicate prevention and parent-outcome closure. Do not build another notifications database, parent state machine or separate watchdog LLM. Persistent warnings must route to the same owner queue whether seen locally or through the approved Telegram transport.


### 5.5 Separate Auto Release mode (owner approved D5; tracked #13)

**Product direction approved:** AIWorks will include **two per-project release modes**:

- **Review only** - default, current behavior. AIWorks stops after a verified publish/candidate and gives a truthful next action. It never merges, deploys or applies staged changes automatically.
- **Auto Release** - explicitly enabled **per project and destination/environment** after its own versioned release authorization and necessary independent validation. It may progress a verified candidate through release and post-release checks without asking again for each routine eligible deployment **only within the standing grant**.

**Critical authority boundary:** Existing AW-001 prohibits supervisor merge/deploy. The user's approval of this *feature* does not grant production rights to the current supervisor. Before runtime enablement, create a narrowly scoped AW decision/constitution amendment and align the target project's governance contract/release policies, independently review the actual release adapter and perform a disposable rehearsal. Do not grant implementer/verifier agents deployment credentials; release is a separate scoped role/capability with dedicated local authorization and kill switch.

**Eligibility:** immutable candidate artifact/revision; independent verification of the exact revision; required tests/security/UX evidence for that target; authorized destination and permitted change class; no stale dependency or changed head; appropriate migration/rollback readiness; no new recurring spend or elevated permissions; exclusive destination lock and durable idempotent deployment state. Missing/unknown evidence blocks release. Irreversible/destructive migrations and other governance owner-reserved triggers must stop and request owner approval.

**GitHub vs local:** When a GitHub project has a permitted merge gate, Auto Release can use that approved gate and then deploy. A GitHub-less local project has **no PR merge step**: its authorized release adapter checks the original source baseline, applies/publishes an exact reviewed revision to a configured local target with reversible backup, verifies the actual result and records it locally. Never silently copy changes over concurrent owner edits or deploy to arbitrary folders.

**Post-release:** validate health/journey evidence, record target revision and outcome, offer a real pause/revoke/rollback action, alert for failure through #1. A restart reconciles unknown acceptance, rather than repeating a potentially irreversible action. Distinguish merged, applied, deployed and end-user accepted status - including unknown.

**Delivery waves:** govern/authorize release capability -> eligibility evaluator and compact project UI -> local/GitHub release adapters -> independent safety and rollback tests -> explicitly authorized canary. Implementation belongs to #13, not this planning PR. No real release is currently authorized.

## 6. Build order, lanes and file ownership

**In short.** First, AIWorks stops losing time to its own problems: a stopped supervisor comes back by itself (#18), publishing survives a GitHub limit (#21), a pull request that conflicts after a sibling merge is repaired without a hand-written campaign (#27), and more than one step can run at a time. After that, five lanes run as parallel campaigns. Powers that wait for an owner decision (#24 D2, #32 D4, #33 D5-gate) are built switched off, or not built, and each row says which.

This section consolidates the implementation slices of the six merged designs: [PROJECT_CONNECTION](design/PROJECT_CONNECTION.md#10-implementation-slices) (PC), [WORK_ENVELOPE](design/WORK_ENVELOPE.md#12-implementation-slices) (WE), [ADAPTIVE_SCHEDULER](design/ADAPTIVE_SCHEDULER.md#10-implementation-slices) (SCH), [MODEL_ROUTING](design/MODEL_ROUTING.md#13-implementation-slices) (MR), [OWNER_WORKSPACE](design/OWNER_WORKSPACE.md#11-implementation-slices) (OW) and [AUTO_RELEASE](design/AUTO_RELEASE.md#11-implementation-slices) (AR). The designs hold the detail (exact tests, acceptance, reasons). This section decides order, lanes and file ownership only. It replaces the earlier wave table.

### 6.1 Where things stand (observed on main at `f912d23`, 2026-10-12)

| Item | State |
| --- | --- |
| F0-STOPPERS (#17), F1-AW005 (via I1-F1-AW005, #27 workaround), LD1-LOCAL-DATA (#16), R1-REST-PUBLISH (#21), the six designs | Merged on main (observed). Merged is not deployed: what runs on workstation is **unknown** here. |
| R2-KEEPER (#18), F2-DUPLICATE (#5 scope A), F3-CARRYOVER (#6) | Declared in `campaigns/example-reliability.json` and `campaigns/example-foundation.json`; not merged (observed). They run before every lane below. |
| #27 (conflicting published PR) | Open. Only the one-off `example-integrate-f1` workaround exists. |
| One-slot limit | Still in code: `limits.slots` must be 1 and `schedule()` stops at one open operation (observed, [SCH §3](design/ADAPTIVE_SCHEDULER.md#3-every-place-that-assumes-one-slot-and-what-replaces-it)). |
| #24, #32, #33 | Open owner decisions. Each default keeps today's behaviour. |

### 6.2 The rules every slice follows

- **One slice is one reviewable PR**, with `npm run check` and synthetic tests only (disposable stores and git repositories, synthetic executables as in `tests/supervisor/helpers.mjs`; no model, network or GitHub call).
- **Supervisor changes** need the independent review of the exact head ([AGENTS.md](../AGENTS.md#review-and-runtime-maintenance)). The supervisor's verification of the exact head counts as that review (#17).
- **Merged is not deployed.** Nothing changes on workstation except through the upgrade procedure ([SUPERVISOR.md §6](SUPERVISOR.md#6-installation-and-maintenance)). Only the enablement slices (RUN10, MOD7, REL11) touch the live runtime, and each waits for an owner answer.
- **Within a lane, slices run in the listed order.** A slice that waits for a decision never holds up the later slices of its lane that do not depend on it; those are listed last.
- **Across lanes, a shared file has one writer at a time.** A slice that changes a shared file starts only after every earlier slice in [6.9](#69-shared-files-and-the-order-that-avoids-conflicts) that changes the same file is merged. A lane campaign declares that as a dependency with `requiresMergedDependencies`.
- **Off means today.** A slice built switched off ships with its switch off, and with the switch off the full existing suite passes unchanged.

Paths: `sup/` is `src/supervisor/`, `dash/` is `src/dashboard/`, `pub/` is `src/dashboard/public/`, `ts/` is `tests/supervisor/`, `td/` is `tests/dashboard/`. "SUPERVISOR.md" is `docs/SUPERVISOR.md`.

### 6.3 The lanes

| Lane | Outcome for the owner | Slices | Starts |
| --- | --- | --- | --- |
| **RUN** - keep it running, several steps at once | A conflicting PR is repaired by itself; independent steps run in parallel, fairly across projects, safe across crashes. | RUN1-RUN10 | First. Owns the first turn on `controller.mjs`. |
| **MOD** - model choice and cost | Each step uses a fitting model; cost is shown honestly, unknown stays unknown. | MOD1-MOD7 | MOD1 at once; MOD2 after RUN6. |
| **STA** - connect projects and start work | Projects connect (GitHub, local Git, plain folder); one approval grows its own task graph. | STA1-STA17 | STA1, STA2 at once; STA3 after RUN6. |
| **UI** - owner workspace | One question per screen, project first. Every dashboard file is changed only in this lane. | UI1-UI17 | At once. |
| **REL** - Auto Release, switched off | Release can be checked and rehearsed, but never runs until #33. | REL1-REL11 | At once (REL1). |

The declared tasks R2-KEEPER, F2-DUPLICATE and F3-CARRYOVER are not repeated in a lane. They are dependencies. They overlap each other: R2-KEEPER and F2-DUPLICATE both change `sup/api.mjs` and SUPERVISOR.md, in two campaigns with no declared order (observed). Recommended order: R2-KEEPER, then F2-DUPLICATE, then F3-CARRYOVER. The one merged second needs an integration round: the `aw-integrate` workaround until RUN1 exists.

### 6.4 Lane RUN - keep it running, several steps at once

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **RUN1** | A published, unmerged commit task that conflicts with its base after a sibling merge becomes an integration repair round: merge the base, resolve, fresh verification, push the new verified head to the same branch and PR. | `sup/controller.mjs` (integration check, repair round), `sup/adapters/git.mjs` (`git merge-tree --write-tree`), `ts/integration-repair.test.mjs` (new), `ts/helpers.mjs`, SUPERVISOR.md (publication) | R1-REST-PUBLISH (merged), R2-KEEPER, F3-CARRYOVER (SUPERVISOR.md) | From #27: two campaigns, sibling PRs touching one file; after the first merges the second is repaired, verified and still mergeable; no duplicate PR; never a force-push over a verified head; no resolution without verification; journal `integration-conflict`, `integration-repaired` | No |
| **RUN1B** | A published commit whose CI fails goes back for repair: the supervisor reads the PR head's check runs through REST, a failure reopens the task as a repair round carrying the failing check names, and the verified fix is pushed to the same branch and PR. Status shows CI per published step and never shows one as passed while CI is red or unknown. Built behind `ciRepair.enabled` (default off). | `sup/controller.mjs` (publication follow-up), `sup/adapters/github.mjs` (`GET repos/{repo}/commits/{sha}/check-runs`), `sup/api.mjs` (`ci` in status), `ts/ci-repair.test.mjs` (new), `ts/fixtures/fake-gh.mjs`, SUPERVISOR.md (publication) | RUN1 | From #42: a failed run reopens a repair round with the failing check names; fix verified and pushed as a fast-forward to the same PR, no duplicate PR; at most one CI read per minute per published task, none once CI completes; no repair of a PR no longer open at that head; bounded by `maxRepairRounds`; rate limit waits for the reset; status `ci` never `success` while CI is red or unknown; off by default, no CI read | No to build. Turning it on live is a runtime config change through the upgrade procedure. |
| **RUN2** | The controller is correct with several open operations; bases come from an explicit ref, not `FETCH_HEAD`. Behaviour with one slot unchanged. | `sup/controller.mjs`, `sup/store.mjs` (one open operation per task), `sup/api.mjs` (cost reservation, all open operations), `ts/multi-op.test.mjs` (new) | RUN1, STA1 (store), F2-DUPLICATE, R2-KEEPER | SCH S2 tests | No |
| **RUN3** | One provider-account cooldown holds every campaign on that account. | `sup/accounts.mjs` (new), `sup/store.mjs` (`provider_waits`), `sup/controller.mjs`, `sup/api.mjs`, SUPERVISOR.md §4, `ts/provider-accounts.test.mjs` (new) | RUN2, MOD1 (SUPERVISOR.md) | SCH S1 tests | No (SCH Q1 refines accounts; the default ships) |
| **RUN4** | Tasks may declare `writes`; ownership lasts until integration; out-of-domain commits are refused; `limits.slots` accepts `1..8` and `"auto"`. | `sup/campaign.mjs`, `sup/work-ownership.mjs`, `sup/adapters/git.mjs` (`changedPaths`), `sup/controller.mjs`, SUPERVISOR.md §1, `ts/write-domain.test.mjs` (new) | RUN3, F2-DUPLICATE | SCH S3 tests; old declarations digest unchanged | No |
| **RUN5** | One admission pass per tick runs independent ready steps across campaigns and projects, fairly, with adaptive fan-out, behind `scheduler.enabled` (default off). **This removes the one-slot limit in code.** | `sup/scheduler.mjs` (new), `sup/controller.mjs`, `sup/store.mjs` (`capacity`), SUPERVISOR.md, `ts/scheduler.test.mjs`, `ts/parallel.test.mjs` (new) | RUN3, RUN4 | SCH S4 tests; serial-vs-parallel run of one synthetic DAG | No to build. Turning it on live is RUN10. |
| **RUN6** | Restart, takeover and cancel guarantees hold with several open operations and two controllers. | `ts/restart.test.mjs`, `ts/parallel.test.mjs`; `sup/controller.mjs` only for defects a test exposes | RUN5 | SCH S7 tests, none skipped on Windows | No |
| **RUN7** | Host memory, CPU, disk and heartbeat pressure stop new admission; running work continues. | `sup/host.mjs` (new), `sup/scheduler.mjs`, `ts/scheduler.test.mjs` | RUN5 | SCH S5 test | No |
| **RUN8** | A quota outcome halves an account's concurrency; useful results raise it again. | `sup/accounts.mjs`, `sup/scheduler.mjs`, `ts/provider-accounts.test.mjs` | RUN3, RUN7 | SCH S6 test | No |
| **RUN9** | Status gives one plain wait reason and the next automatic action for every waiting step (supervisor half of SCH S8). | `sup/api.mjs` (`wait` per task), `ts/status.test.mjs` | RUN8, REL4 (api turn) | Status returns one reason per waiting task, built only from supervisor fields | No |
| **RUN10** | The live runtime runs the scheduler (`scheduler.enabled: true`), after a disposable two-project rehearsal on workstation. Runbook only. | SUPERVISOR.md §6, `docs/STATUS.md` | RUN1-RUN8 merged (RUN9 recommended) | Full suite at the deployed SHA; serial vs parallel on workstation; status before and after | Not #24/#32/#33. Waits for SCH Q2 and Q3 (owner; no issue raised yet, gap G5). |

### 6.5 Lane MOD - model choice and cost

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **MOD1** | `supervisor baseline` prints the cost and outcome baseline from any store, read-only. | `sup/baseline.mjs` (new), `sup/cli.mjs`, SUPERVISOR.md (short section), `ts/baseline.test.mjs` (new) | R2-KEEPER (cli.mjs), RUN1 (SUPERVISOR.md) | MR R1 tests; store byte-identical after the run | No |
| **MOD2** | Every new operation stores a static routing receipt naming today's choice and model. Behaviour unchanged. | `sup/router.mjs` (new), `sup/store.mjs` (`routing` column), `sup/controller.mjs` (`executorChoice`), `ts/routing-receipt.test.mjs` (new) | MOD1, STA3 (controller turn), REL3 (store turn) | MR R2 tests, including replay and `after-record` crash | No |
| **MOD3** | `routing`, task `role`, risk and complexity validate; roles come from the governance contract's catalog in the governance checkout. | `sup/governance.mjs`, `sup/campaign.mjs`, `sup/api.mjs` (routing amendment), `tests/fixtures/governance/registry/agents.json`, `ts/campaign-registry.test.mjs`, SUPERVISOR.md | MOD2, RUN4 (`writes`), RUN9 (api turn), F2-DUPLICATE | MR R3 tests; no scope digest in `campaigns/` changes | No |
| **MOD4** | The router policy as a pure function (`routing-policy/1`). | `sup/router.mjs`, `ts/router.test.mjs` (new) | MOD3 | MR R4 tests and the MR §10 table | No |
| **MOD5** | Campaigns with `routing.mode: "auto"` dispatch with the router's model; escalation follows recorded outcomes only. | `sup/controller.mjs`, `sup/adapters/executors.mjs`, `ts/fixtures/fake-claude.mjs`, `ts/routing.test.mjs` (new) | MOD4, RUN3 (account waits), STA9 (controller turn) | MR R5 tests; no model call on idle ticks | No |
| **MOD6** | Status carries model, tier, cost by unit, unknown-cost count and escalation reason per step (supervisor half of MR R6). | `sup/api.mjs`, `ts/status.test.mjs` | MOD5, RUN9 (status test) | Units never summed; unknown stays unknown | No |
| **MOD7** | Baseline recorded, one cohort runs with routing on workstation, comparison published. Runbook and one declaration. | SUPERVISOR.md, `docs/STATUS.md`, one cohort file in `campaigns/` | MOD1-MOD5 merged and deployed (MOD6 recommended) | `supervisor baseline` before and after; status before and after | Not #24/#32/#33. Waits for MR Q1 and Q2 (owner; no issue raised yet, gap G5). |

### 6.6 Lane STA - connect projects and start work

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **STA1** | Project records exist and survive restarts. | `sup/projects.mjs` (new), `sup/store.mjs` (additive), `ts/projects.test.mjs` (new) | F2-DUPLICATE (store.mjs) | PC S1 tests | No |
| **STA2** | Read-only preflight tells GitHub, local Git and plain folder apart. | `sup/project-preflight.mjs` (new), `ts/project-preflight.test.mjs` (new) | STA1 | PC S2 tests; source snapshot unchanged | No |
| **STA3** | GitHub projects connect, and campaigns resolve their checkout through them. | `sup/project-connect.mjs` (new), `sup/controller.mjs` (`repo()` only), `sup/campaign.mjs` (extract `governanceForContract`), `ts/project-github.test.mjs` (new) | STA2, RUN6 (controller turn), RUN4 (campaign turn), F2-DUPLICATE | PC S3 tests; `campaign-registry` and `packet-governance` unchanged | No |
| **STA4** | Local Git projects connect with a managed mirror; `startWork` is false (`LOCAL_START_OFF`). | `sup/adapters/mirror.mjs` (new), `sup/project-connect.mjs`, `ts/project-local-git.test.mjs` (new) | STA3 | PC S4 tests; owner's `.git` untouched | Connect: no. Starting work waits for #24 and #32 (off: `LOCAL_START_OFF`). |
| **STA5** | Plain folders connect with a managed snapshot and baselines; the source stays byte-identical. | `sup/adapters/mirror.mjs`, `ts/project-folder.test.mjs` (new) | STA4 | PC S5 tests | Same as STA4 |
| **STA6** | Task specs come from one accessor, ready for child tasks. No behaviour change. | `sup/plan.mjs` (new), `sup/store.mjs` (`task_specs`, `plan_amendments`), `sup/controller.mjs`, `sup/api.mjs`, `ts/plan-specs.test.mjs` (new) | STA5, MOD3 (api turn), MOD2 (store and controller turn), F2-DUPLICATE | WE E1 tests; no packet digest changes | No |
| **STA7** | Version 2 declarations with an `envelope` block validate; `release.mode` accepts only `review-only`. | `sup/campaign.mjs`, SUPERVISOR.md §1, `ts/envelope-schema.test.mjs` (new) | STA6, RUN4 (`writes`) | WE E2 tests; v1 digests unchanged | Built now; `auto-release` is refused until #33 (see C10). |
| **STA8** | Child tasks are admitted, chained to the envelope and idempotent across crash and retry. | `sup/plan.mjs`, `sup/controller.mjs`, `sup/work-ownership.mjs`, `ts/plan-admission.test.mjs`, `ts/plan-crash.test.mjs` (new) | STA7 | WE E3 tests: every widening refused with its code | No |
| **STA9** | Children run with their own packet binding, re-checked before every dispatch. | `sup/controller.mjs`, a new controller test file under `ts/` | STA8, RUN4 (changed paths) | WE E4 tests; declared tasks' packets byte-identical | No |
| **STA10** | AIWorks adds steps by itself and closes the outcome with a generated closing check. | `sup/adapters/executors.mjs`, `sup/controller.mjs`, `ts/envelope-e2e.test.mjs` (new) | STA9, MOD5 (controller and executors turn) | WE E5 tests; #8 acceptance "one start ... finish without the owner" | No |
| **STA11** | An approved plan starts only under its exact private approval digest and merged runtime code. | Private approvals, local loader and CLI | STA10 and merged runtime enforcement | Private approval tests | No public declaration |
| **STA12** | The owner can ask by goal, issue, PR or plan file, or plan only; drafts are never scheduled. | `sup/intake.mjs` (new), `sup/coordinator.mjs`, `sup/store.mjs` (`work_requests`, `work_drafts`), `ts/intake.test.mjs` (new) | STA11, STA1, STA4 | WE E6 tests | No |
| **STA13** | Persist private approved declarations and register them idempotently; never publish a declaration PR. | Private approval store and local loader | STA12 | Restart and digest-binding tests | Private installation data only |
| **STA14** | Local projects get verified candidates in a local ledger, never a fake PR. Inert until local admission is on. | `sup/local-candidates.mjs` (new), `sup/controller.mjs` (publish branch for local kinds), `ts/local-candidates.test.mjs` (new) | STA13, STA9, STA5 | WE E10 tests; `gh` never called | Built now, inert; used only after #24 and #32 (STA17). |
| **STA15** | AIWorks side of D2: local overlay entries validate against the governance contract's merged schema; `LOCAL_ADMISSION` stays false. | `sup/local-overlay.mjs` (new), `sup/campaign.mjs` (`overlayGovernance`), `tests/fixtures/governance-overlay/` (copy of the governance contract's merged schema), `ts/local-overlay.test.mjs` (new) | STA14, STA4; governance merge of the PC §7.3 change | PC S7 tests | **#24.** Not built until #24 is answered and governance merges the schema (the fixture copies the merged schema). Meanwhile local projects connect and are checked but get no rules. |
| **STA16** | D4 local admission built and tested with synthetic keys, behind `LOCAL_ADMISSION = false`. | `sup/local-admission.mjs` (new), trust-root reader, `ts/local-admission.test.mjs` (new) | STA15, STA14, STA11, STA8 | WE E11 tests with a synthetic `ssh-keygen` | **#32** to use; built off. Its STA15 dependency makes it wait for **#24** too (C9). |
| **STA17** | Work starts on projects without GitHub: `LOCAL_ADMISSION = true`, private installation trust root, D4 recorded. | `sup/local-admission.mjs`, private trust-root file, `docs/DECISIONS.md`, SUPERVISOR.md | STA16, UI16 (rules approval) | WE E12 full local end-to-end with a synthetic signer | **#32** (items 1 and 3) and **#24**. Stays off until both. |

### 6.7 Lane UI - owner workspace

Every file under `src/dashboard/`, `tests/dashboard/` and `docs/OPERATIONS_DASHBOARD.md` is changed only in this lane (R2-KEEPER's one status line is the declared exception and comes first). The other designs' dashboard halves are lane UI slices.

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **UI1** | A synthetic store and a disposable local git repository show every state of OW §7 for a disposable review dashboard (no fake `gh`, see C1). | `td/fixtures/review-store.mjs` (new) | LD1-LOCAL-DATA (merged) | `td/review-fixture.test.mjs`; baseline blind review on port 4319 | No |
| **UI2** | Navigation shell: Projects, Needs me, Settings; project tabs; hash addresses; old addresses redirected; 320px layout. | `pub/index.html`, `pub/dashboard.css`, `pub/dashboard.js`, `pub/router.mjs` (new), `dash/server.mjs`, `td/router.test.mjs` (new), `td/dashboard.test.mjs`, `td/presentation.test.mjs` | UI1 | OW S1 tests | No |
| **UI3** | Projects screen from today's data: one row per repository, one state, one action. | `dash/projects.mjs` (new), `dash/server.mjs`, `pub/dashboard.js`, `td/projects.test.mjs` (new) | UI2 | OW S2 tests | No |
| **UI4** | Needs me: today's items grouped by project, "AIWorks itself" last. | `dash/owner.mjs`, `pub/dashboard.js`, `td/owner.test.mjs`, `td/claims.test.mjs` | UI3 | OW S3 tests | No |
| **UI5** | Now screen and all state copy in one module. | `dash/copy.mjs` (new), `pub/dashboard.js`, `td/copy.test.mjs` (new) | UI4 | OW S4 tests | No |
| **UI6** | Work and Step screens, step history, Pause, Check again, Cancel, Resume. | `dash/supervisor.mjs`, `pub/dashboard.js`, `td/work.test.mjs` (new) | UI5, R2-KEEPER (`dash/supervisor.mjs`) | OW S5 tests | No |
| **UI7** | Results grouped by state, "Passed the check" wording; merged never reads released. | `dash/owner.mjs`, `pub/dashboard.js`, `td/claims.test.mjs` | UI6 | OW S6 tests without the GitHub review state (C1, gap G3) | No |
| **UI8** | Cost per project and per step; unreported runs counted apart. | `dash/supervisor.mjs`, `pub/dashboard.js`, `td/cost.test.mjs` (new) | UI7 | OW S7 tests | No |
| **UI9** | Settings and Diagnostics: this computer, AI workers, connections, Release mode as text, Messages, journal, roadmap, merge-check freshness. | `dash/supervisor.mjs`, `pub/dashboard.js`, `td/settings.test.mjs` (new) | UI8 | OW S8 tests; Auto Release shown off with no control | No |
| **UI10** | Start work: Plan only, sent as a structured coordinator message. | `pub/dashboard.js`, `dash/supervisor.mjs`, `td/messages.test.mjs` | UI9 | OW S9 tests; Plan only never changes a file or registers work | No |
| **UI11** | The Work view shows the supervisor's wait reason for each waiting step (dashboard half of SCH S8). | `dash/supervisor.mjs`, `pub/dashboard.js`, `td/work.test.mjs` | UI10, RUN9 | No worker text in a reason | No |
| **UI12** | Work and Cost show model, tier, cost by unit and escalation reason (dashboard half of MR R6, extending UI8). | `dash/supervisor.mjs`, `pub/dashboard.js`, `td/cost.test.mjs` | UI11, MOD6 | Units never summed; unknown never $0.00 | No |
| **UI13** | Add project for GitHub, local Git and plain folders, from the Projects screen. | `dash/projects.mjs`, `dash/server.mjs` (connect routes, origin, CSRF, 16 KiB), `pub/*` (Projects area), `docs/OPERATIONS_DASHBOARD.md`, `td/projects.test.mjs`, `td/connect.test.mjs` (new) | UI12, STA5 | PC S6 and OW S11 tests; no file in the folder changes on connect; no absolute path served except the owner's root | Connecting: no. Start work on a local project shows as not available until #24 and #32. |
| **UI14** | Plan and do: Review, then Approve for a GitHub project, under AW-005. | `dash/work.mjs` (new), `dash/server.mjs`, `dash/supervisor.mjs`, `pub/*` (Start work and Review), `docs/OPERATIONS_DASHBOARD.md`, `td/approve.test.mjs` (new) | UI13, STA11, STA12 | WE E8 and OW S10 tests; no dashboard path registers what the CLI would refuse | Built with **automatic start off**: after the merge the owner sees *Ready to start* and runs `start`, as today. Turning it on waits for the owner (C3, #32). |
| **UI15** | Release view: mode row, five-step ladder, unknown and failure lines in Needs me, **Stop all releases**; the Auto Release switch appears only with a valid grant. | `dash/supervisor.mjs`, `dash/owner.mjs`, `pub/*`, `td/release.test.mjs` (new) | UI14, REL2, REL4 | AR R9 and OW S13 tests: unknown never success; switch absent without a grant | **#33.** Built now showing Review only and Stop all releases; no grant can exist, so the switch never shows until #33. |
| **UI16** | The owner approves and renews a local project's rules with a typed confirmation. | `dash/projects.mjs`, `pub/*` (rules review), `td/projects.test.mjs` | UI15, STA15 | PC S8 tests; no worker or coordinator path writes overlays | **#24.** Not built until #24 and STA15. |
| **UI17** | Plan, approve and apply for projects without GitHub; local results show *Ready to apply*. | `dash/**` (local project screens), `td/local.test.mjs` (new) | UI16, STA17, STA14; the review-only apply operation (gap G2); a local reply place for the coordinator (gap G4) | OW S12 tests: no PR ever shown; apply refused on a changed folder | **#24 and #32.** Not built until both, and until G2 and G4 are designed. |

After UI9, run the blind review of [OW §13](design/OWNER_WORKSPACE.md#13-blind-review-protocol-ux-002-pass-a) (pass A, then B, B2, C). Findings become fix PRs in this lane. #11 is accepted only with no blocker or must finding open. This is a gate, not a slice.

### 6.8 Lane REL - Auto Release, switched off

Every slice ships with `release.enabled: false` and no release credential (AR §11). No release can run before #33.

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **REL1** | AIWorks reads and validates a standing release record and says why one is invalid. Nothing acts on it. | `schemas/release-authorization.schema.json` (new), `sup/release/authorization.mjs` (new), `ts/release-authorization.test.mjs` (new) | none | AR R1 tests | Built off (#33) |
| **REL2** | Status reports, per done task and destination, "would be eligible" or "not eligible, because ...". Report only. | `sup/release/classify.mjs`, `sup/release/eligibility.mjs` (new), `sup/api.mjs` (`release` field), `ts/release-eligibility.test.mjs` (new) | REL1, RUN3 (api turn) | AR R2 tests: every check fails on missing or unknown evidence | Built off (#33) |
| **REL3** | Durable release rows, one lock per destination, intent before effect, reconciliation with a fake adapter. | `sup/store.mjs` (`releases`, `release_locks`), `sup/release/state.mjs` (new), `ts/release-state.test.mjs` (new) | REL2, RUN5 (store turn) | AR R3 tests | Built off (#33) |
| **REL4** | `RELEASE-STOP`, per-project mode (default Review only) and `release.enabled` checked before every step; CLI `release-stop`, `release-mode ... review-only`. | `sup/release/state.mjs`, `sup/cli.mjs`, `sup/api.mjs`, SUPERVISOR.md (release section, "built, not enabled"), `ts/release-switches.test.mjs` (new) | REL3, MOD1 (cli turn) | AR R4 tests; no command can switch a project to Auto Release | Built off (#33) |
| **REL5** | A release step runs in its own clean process; the credential is fetched by reference only. | `sup/release/runner.mjs`, `sup/release/credential.mjs` (new), `ts/release-runner.test.mjs` (new), a static test under `ts/` that merge, deploy and apply calls live only in `sup/release/` | REL4 | AR R5 tests; synthetic credential never in journal, row, log or packet | Built off; using it waits for **#33** item 2 |
| **REL6** | GitHub merge adapter: `--match-head-commit`, tree equality, reconciliation, revert-PR proposal. | `sup/release/github-merge.mjs` (new), `sup/adapters/github.mjs` (read-only `pullRequestState`), `ts/release-github.test.mjs` (new) | REL5, STA13 (github.mjs turn) | AR R6 tests: never two merge calls for one release | Built off; running on a real repository waits for **#33** |
| **REL7** | Deploy, check and rollback through the project's own commands at the exact revision, with drift check and automatic rollback. | `sup/release/deploy.mjs` (new), `ts/release-deploy.test.mjs` (new) | REL6 | AR R7 tests | Built off; a real destination waits for **#33** |
| **REL8** | `local-git-apply` and `local-folder-apply` with backup, apply, confirm, rollback and reconciliation. | `sup/release/local-apply.mjs` (new), `ts/release-local.test.mjs` (new) | REL4, STA5 | AR R8 tests, none skipped on Windows | **#24** (a local grant needs D2), then **#33**. Not built before #24. |
| **REL9** | The release decision and its three cross-references are recorded with the next free AW number (C2). | `docs/DECISIONS.md`, `docs/PRODUCT_CONSTITUTION.md`, `AGENTS.md`, `docs/STATUS.md` | REL7, F3-CARRYOVER (REL8 not needed) | `npm run check`; text matches the owner's accepted wording | **#33** item 1. Not written before. |
| **REL10** | the governance contract's project-contract schema accepts the release executor and record; AIWorks's registry entry carries it. **An governance pull request by the governance contract's process, proposed from here as text only.** | In `example-org/governance`: `schemas/project-contract.schema.json`, `registry/projects/aiworks.json` | REL9 | the governance contract's own validation | **#33** and governance review |
| **REL11** | Disposable rehearsal on workstation, then one granted canary. Runbook only. | SUPERVISOR.md (enable and roll back), `docs/STATUS.md` | REL1-REL7, REL9, REL10 merged and deployed (REL8 for a local canary, UI15 recommended) | Full suite at the deployed SHA; forced check failure with rollback; controller killed mid-merge and mid-deploy | **#33** items 1-3. Nothing before. |

REL8 to REL11 wait for decisions; REL9 does not wait for REL8.

### 6.9 Shared files and the order that avoids conflicts

Files touched by one lane only (for example `sup/scheduler.mjs`, `sup/router.mjs`, `sup/release/*`, `sup/adapters/mirror.mjs`, everything under `src/dashboard/`) follow the lane order. Files touched by more than one lane, or by a declared task and a lane, follow this global turn order. A slice starts only after every earlier slice in the list that touches the same file is merged:

**Turn order:** R2-KEEPER → F2-DUPLICATE → F3-CARRYOVER → RUN1 → RUN1B → STA1 → MOD1 → RUN2 → RUN3 → REL2 → RUN4 → RUN5 → REL3 → REL4 → RUN6 → RUN9 → STA3 → MOD2 → MOD3 → STA6 → STA7 → STA8 → STA9 → MOD5 → MOD6 → STA10 → STA11 → STA12 → STA13 → REL6 → STA14 → RUN10 → MOD7 → STA15 → STA16 → STA17 → REL9 → REL11.

| Shared file | Writers, in order |
| --- | --- |
| `sup/controller.mjs` | RUN1, RUN1B, RUN2, RUN3, RUN4, RUN5, RUN6, STA3, MOD2, STA6, STA8, STA9, MOD5, STA10, STA14 |
| `sup/store.mjs` | F2-DUPLICATE, STA1, RUN2, RUN3, RUN5, REL3, MOD2, STA6, STA12 |
| `sup/api.mjs` | R2-KEEPER, F2-DUPLICATE, RUN1B, RUN2, RUN3, REL2, REL4, RUN9, MOD3, STA6, MOD6 |
| `sup/campaign.mjs` | F2-DUPLICATE, RUN4, STA3, MOD3, STA7, STA15 |
| `sup/cli.mjs` | R2-KEEPER, MOD1, REL4, STA11 |
| `sup/work-ownership.mjs` | F2-DUPLICATE (creates), RUN4, STA8 |
| `sup/adapters/github.mjs` | R1-REST-PUBLISH (merged), RUN1B, STA13, REL6 |
| `sup/adapters/executors.mjs` | MOD5, STA10 |
| `ts/helpers.mjs` | R2-KEEPER, RUN1, STA13 |
| `ts/status.test.mjs` | RUN9, MOD6 |
| `dash/supervisor.mjs` | R2-KEEPER, then lane UI only |
| `docs/SUPERVISOR.md` | R2-KEEPER, F2-DUPLICATE, F3-CARRYOVER, RUN1, RUN1B, MOD1, RUN3, RUN4, RUN5, REL4, MOD3, STA7, RUN10, MOD7, STA17, REL11 |
| `docs/STATUS.md` | F3-CARRYOVER, RUN10, MOD7, REL9, REL11 |
| `docs/DECISIONS.md` | F3-CARRYOVER, STA17, REL9 |

Two cases need the order spelled out:

- **`controller.mjs` is the bottleneck.** Fifteen slices change it, one at a time. RUN goes first because parallel work and conflict repair speed up every later slice. Meanwhile the other lanes do their slices that avoid it: STA1, STA2, MOD1, MOD4, REL1 to REL5, REL7 and all of lane UI.
- **STA17 and REL9 both append a decision** after an owner answer whose timing is unknown. The listed order holds; if #33 is answered first, REL9 may go first, and STA17 then starts after REL9 is merged. Both only append a new record.

### 6.10 What waits for #24, #32 and #33

| Decision | Built switched off meanwhile | Stays off or unbuilt until answered |
| --- | --- | --- |
| #24 D2 - local projects inherit governance rules | STA4, STA5 connect local projects with `LOCAL_START_OFF`; STA14 local candidates, inert; UI13 connects local projects and says starting work is not available | STA15 (needs the governance contract's merged schema), STA16 (through STA15), STA17, UI16, UI17, REL8 |
| Local project admission | Private approval and local identity contracts remain proposals; no declaration publisher | Enable only separately authorized local execution capabilities |
| #33 D5-gate - Auto Release | REL1-REL7 (`release.enabled: false`, no credential); UI15 (Review only, Stop all releases, no switch without a grant); STA7 refuses `auto-release` | REL9, REL10, REL11; any real grant, credential or canary; REL8 also needs #24 |

Telegram delivery (#1) has no slice in this order and stays off. Needs me stays the one source it would later send.

### 6.11 Design slice → build-order slice

Every design slice appears once. "Merged" means two design slices became one build slice; "split" means one design slice has a supervisor half and a dashboard half.

| Design | Mapping |
| --- | --- |
| SCH | S1→RUN3, S2→RUN2, S3→RUN4, S4→RUN5, S5→RUN7, S6→RUN8, S7→RUN6, S8→RUN9 + UI11 (split), S9→RUN10 |
| MR | R1→MOD1, R2→MOD2, R3→MOD3, R4→MOD4, R5→MOD5, R6→MOD6 + UI12 (split), R7→MOD7 |
| PC | S1→STA1, S2→STA2, S3→STA3, S4→STA4, S5→STA5, S6→UI13 (merged with OW S11), S7→STA15, S8→UI16 |
| WE | E1→STA6, E2→STA7, E3→STA8, E4→STA9, E5→STA10, E6→STA12, E7→STA11, E8→UI14 (merged with OW S10), E9→STA13, E10→STA14, E11→STA16, E12→STA17 |
| OW | S0→UI1, S1→UI2, S2→UI3, S3→UI4, S4→UI5, S5→UI6, S6→UI7, S7→UI8, S8→UI9, S9→UI10, S10→UI14 (merged), S11→UI13 (merged), S12→UI17, S13→UI15 (merged with AR R9) |
| AR | R1→REL1, R2→REL2, R3→REL3, R4→REL4, R5→REL5, R6→REL6, R7→REL7, R8→REL8, R9→UI15 (merged), R10→REL9, R11→REL10, R12→REL11 |
| Issue #27 (no design slice) | RUN1 (gap G1) |

Reasons for the merges and splits:

- **PC S6 + OW S11 → UI13.** Same outcome (Add project on the Projects screen), same new file `dash/projects.mjs` and the same test file. One owner.
- **WE E8 + OW S10 → UI14.** Same outcome (Review, then Approve and start for a GitHub project), same routes and screens.
- **AR R9 + OW S13 → UI15.** The release-mode row and the Auto Release switch are one control on one screen. The switch shows only with a valid grant, so building them together keeps it off until #33.
- **SCH S8 and MR R6 split.** Their supervisor halves change `sup/api.mjs` in lanes RUN and MOD; their dashboard halves change files only lane UI may change. Both designs already defer their dashboard part to the #11 file owner.

### 6.12 Contradictions between designs, and how they are resolved

| # | Contradiction | Resolution | Reason |
| --- | --- | --- | --- |
| C1 | OW S0 (fake `gh`), S6 ("Changes requested" from GitHub's review decision through `dash/roadmap.mjs`), S8 ("Refresh GitHub"), §7.4 ("GitHub stale") and §13.1 (`commands.gh`) assume the dashboard reads GitHub. LD1-LOCAL-DATA (merged, #16) removed every dashboard GitHub call. | The dashboard stays GitHub-free. UI1 uses a synthetic store and a local git repository; UI7 drops "Changes requested" (gap G3); UI9 shows merge-check freshness instead of Refresh GitHub; "GitHub stale" copy becomes LD1's old-merge-check copy. | LD1 is merged and fixed an account-wide rate-limit incident (#16). A design written before it cannot bring the calls back. |
| C2 | AR §10.1 and R10 name the release decision AW-008. F3-CARRYOVER records AW-008 for the executor chain. | F3 keeps AW-008. REL9 takes the next free number when it merges. | F3 is declared first, and #33 already says so. |
| C3 | OW Q1 and WE §11 Q2 ask the owner whether approving in the dashboard counts as registering the plan. #32 lists the same point as "already decided, not asked" (plan §3.2, §4, D3). | UI14 is built with automatic start off (*Ready to start*, CLI `start`, as today). It is switched on only after the owner confirms on #32. | Two designs call it owner-reserved and the dashboard runbook forbids dashboard registration today. Off keeps current behaviour; a confirmation costs one line on an open issue. |
| C4 | Who builds the Review-only local "Apply"? AR §4.1 says #7; PC §10 says #13 and #8; WE §12 says #13. No design has a slice for it. AR R5's static test allows apply code only under `sup/release/`. | Listed as gap G2. When designed, it reuses REL8's adapter, so AR R5's test holds. UI17 waits for it. | No design supports a slice, so none is invented. |
| C5 | OW S2 and PC S6 both create `dash/projects.mjs` and `td/projects.test.mjs`. | UI3 creates both; UI13 extends them. | One owner per file. |
| C6 | OW S5 and WE E8 both create `td/work.test.mjs`. | UI6 owns it for the Work screen; UI14 uses `td/approve.test.mjs` (OW S10's name). | Same file name for two different screens. |
| C7 | OW S5 writes new wait sentences in `dash/supervisor.mjs`; SCH S8 makes status the source of wait reasons. | UI6 renders today's waits; UI11 then switches the Work view to the status `wait` field from RUN9. | One source of truth for why a step waits. |
| C8 | OW S7 and MR R6 both build a per-step cost view. | UI12 extends UI8's Cost screen. There is one cost view. | No duplicate screen. |
| C9 | WE E11 is "no decision to build", but depends on PC S7, which cannot be built before governance merges the D2 schema (#24). | STA16 waits for #24 through STA15. | The dependency is real: local admission validates rules from the overlay. |
| C10 | WE E2 puts `release.mode` in each campaign's envelope; AR §3 says the mode is per project and destination, never per campaign, and approving a campaign never turns Auto Release on. | STA7 accepts only `review-only`, which both allow. What the envelope field means after #33 is gap G6. | Until #33 the two agree in behaviour. |
| C11 | OW says S2 to S8 may run in parallel after S1. All of them change `pub/dashboard.js`. | Lane UI runs them in order. | No two slices may change one file at once. |
| C12 | PC S4 changes `sup/project-connect.mjs`, which PC S3 creates, but lists only S1 and S2 as dependencies. | STA4 follows STA3. | The file must exist first. |
| C13 | The previous section 6 put multiple workers in wave 4, after the workspace. | RUN goes first. | #14 asks for the operational fixes and the one-slot limit first, because they speed up everything after. |

### 6.13 Gaps

- **G1.** #27 has a fix direction but no design slice. RUN1 is built from #27's text (tests included) and links it. If the verifier judges that too thin, a short design note precedes RUN1.
- **G2.** The Review-only local "Apply" has no slice in any design (C4).
- **G3.** "Changes requested" in Results needs GitHub's review state, which the dashboard no longer reads and the supervisor does not store. No design supplies it.
- **G4.** Where the coordinator posts a plan for a project without GitHub is unknown ([OW §14](design/OWNER_WORKSPACE.md#14-open-unknowns)). UI17 cannot finish without it.
- **G5.** Owner questions with no issue yet: SCH Q2 and Q3 (live scheduler, host ceiling; RUN10), MR Q1 and Q2 (models per account, live routing; MOD7). Under [AGENTS.md](../AGENTS.md#owner-intervention) each becomes one `owner-reserved` issue when its slice is reached, with today's behaviour as the default. SCH Q1 ships with its default. OW Q3 (Telegram) is answered "not in this program" by the design.
- **G6.** After #33, whether the envelope's `release.mode` is dropped or shown only (C10).
- **G7.** The governance-side changes (D2 schema for STA15, release schema for REL10) are proposed as text in PC §7.3 and AR §10.2. They are made by the governance contract's own process, never from here.
- **G8.** workstation state is unknown here. Whether R1-REST-PUBLISH, LD1-LOCAL-DATA or F1-AW005 is deployed has not been checked.

### 6.14 Implementation boundaries (kept)

- `src/supervisor/`: durable admission, coordination and concurrency. #5's owner (F2-DUPLICATE) goes first on `api.mjs`, `campaign.mjs` and `store.mjs` (see 6.9).
- `src/dashboard/`: lane UI only. Keep the security headers, origin and CSRF checks, the 127.0.0.1 binding (AW-003), and never serve raw prompts, secrets or paths beyond the owner's own project root.
- `campaigns/`: initial approved private approved declarations (AW-005). No local admission ledger or child amendment runs before its decision.
- `docs/`: AIWorks-specific flow, decisions and operations. governance standards are linked, not copied.
- Stop before a slice whose row names an open decision; every other slice proceeds.

## 7. Evidence and success metrics

Measure before optimizing; do not infer a baseline from counts on a dashboard. Existing product metrics remain:
- Hours per week authorized work is idle while genuinely waiting on an owner action.
- Number of owner interruptions per week and proportion with a justified owner-reserved cause.

Add operational diagnostics (not new product goals):
- Time and number of actions from opening a local UI to first **authorized active work**, including only the governance/PR gates applicable to that source kind.
- Number of concurrent independent *useful* tasks; accepted outcomes per elapsed hour; percent of unproductive reruns/overlapping repairs.
- For each project: tasks ready, running, waiting (with cause), PR published, merged, release unknown/deployed/accepted, last verified evidence time.
- Per accepted outcome: reported model usage and costs, unknown cost count, verification/retry overhead, total time and rejected attempts. Do not claim savings without comparable receipts.
- Owner's ability to answer the screen's primary question without opening a technical panel (blind UX test).

Acceptance must use source-appropriate evidence: L0 plan, L1 interactive UI review, L2 contract tests, L3 integration, L4 workstation runtime check and further target-project/client evidence only where the particular claim requires it. Unknown is not green. All supervisor-code changes need independent approval of the exact commit, and live checkout changes require the documented pinned-upgrade sequence.


## 8. Owner decisions and remaining implementation-design gates

**Owner acceptance recorded 2026-10-12 in the AIWorks conversation (PR #12):**

- **D1 - APPROVED:** Fully local projects are supported. GitHub is optional, including support for a folder with no remote and no Git metadata. Do not claim offline LLM availability. See #7.
- **D3 - APPROVED:** After one authorization of the requested outcome and boundaries, the system autonomously plans, splits, assigns, retries, reviews and closes **internal tasks** without separate approvals for each child. A new outcome/permission/release authorization is not covered. See #8 and #9.
- **D5 - APPROVED PRODUCT DIRECTION:** Provide a distinct **opt-in Auto Release** mode in addition to default manual review. This is **not** immediate authorization to merge/deploy; AW-001 and governance release gates remain effective until their separately reviewed narrow amendment/authorization. See #13 and section 5.5.
- **D9 - APPROVED:** The owner interface is **English**. No localization implementation is planned in this scope. See #11.

| ID | Still-open detailed design/authority question | Proposed resolution pending proper review | Dependency |
| --- | --- | --- | --- |
| **D2** | How does a **local-only project** inherit governance without per-folder GitHub PRs? | A reviewed governance contract extension to allow owner-approved, locally recorded project identities validated against inherited policies; do not let a local overlay weaken governance rules. | governance scoped contract PR + #7 |
| **D4** | How can fully local projects authorize campaigns and produce new child tasks while AW-005 requires an AIWorks main declaration? | Retain trusted reviewed/pinned code; introduce a **separately approved AW-005 local admission exception** using signed/tamper-evident owner authorizations, plus append-only child-plan records constrained by the original approved scope. The normal GitHub main path remains available. | AW-005 decision, #2, #5, #6, #8 |
| **D5-gate** | Exactly which releases can **Auto Release** perform, and to which destinations? | Default OFF. Separate owner-approved standing capability scoped to project/environment/change classes/target, independent exact-revision verifier, eligibility/rollback/health gates; narrowly amend AW-001 via a separate reviewed change. | #13 + governance release governance |
| **D6** | Cross-machine aggregation? | Keep the existing AW-006 single-machine dashboard. Multiple projects on the same machine do not require a second-PC view. No change requested. | none |
| **D7** | Worker count? | Adaptive Auto with an optional manual resource concurrency setting. Do not introduce default campaign run/cost ceilings under AW-002. | #9 |
| **D8** | Model choice? | Automatic capability-, role-, quality- and cost-aware routing across existing authorized providers, with optional model pin. Unknown billing stays unknown. | #10 |
| **D10** | Completion semantics? | Independently verified candidate, local apply/PR merge, release and observed outcome are separately evidenced. Auto Release can advance eligible states, not manufacture them. | #4, #8, #13 |

**No additional permission can be inferred from approving a product requirement.** Never silently rewrite governance portfolio rules, AW-001/AW-005, credential boundaries, independent verification or actual project release grants. The above table records design obligations, not reasons to ask the owner the same product questions again. The remaining decisions should be resolved by engineering/review under existing authority where possible; ask the owner only for a genuine owner-reserved release/permission change.

## 9. Planning-only PR acceptance

- [ ] Product purpose and project-first owner journey are understandable without knowledge of the supervisor, DAG or governance, for both local-only and GitHub-backed projects.
- [ ] Every primary screen answers exactly one real-world question, with an observable entry action and useful empty/blocked states.
- [ ] Work is divided among #7..#11, #13 and existing #1..#6, with explicit dependencies and without duplicate implementations.
- [ ] governance policies are linked, not copied, and the current main-only/external-write/local-only boundaries are preserved.
- [ ] Existing runtime evidence is correctly labeled as code/docs observation; no new deployment or UI walkthrough is claimed.
- [x] D1, D3, D5 (product direction), D9 received explicit owner decisions on 2026-10-12 and are recorded above.
- [ ] D2 local inheritance, D4 GitHub-free admission/AW-005 amendment, and D5 release/AW-001 amendment are designed and independently approved before the associated runtime powers are enabled.
- [ ] Implementation proceeds through small independently reviewable PRs, not by merging an entire code rewrite as one branch.

**Out of scope of this draft:** runtime file changes, production upgrade, agent dispatch, new account connections, provider secrets, governance registry writes, actual release/merge/deployment and budget increases. Auto Release and local-only execution are planned capabilities, not currently enabled permissions.
