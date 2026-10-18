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

**Governance gap (decided 2026-10-16, #24):** Today project admission depends on a governance registry entry keyed by GitHub repository. A project without GitHub gets its rules from an **owner-confirmed local overlay entry** whose schema ships with AIWorks; the governance contract is not changed. The entry can only add or tighten rules and inherits every portfolio policy from the governance directory. The owner confirms it once in the dashboard, valid for up to 12 months ([PC §7](design/PROJECT_CONNECTION.md#7-decision-d2-the-rules-a-project-without-github-follows)). The overlay may never waive a governance policy or write the governance checkout. Do not bypass governance because a remote does not exist.

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

The **currently running** supervisor still requires AW-005's merged-main gate. To make a fully local project usable without a GitHub login, the owner decided on 2026-10-16 (#32) that **approving a plan in the local dashboard admits exactly that plan**, bound to its digest, with no signing key and **without GitHub** ([WE §8](design/WORK_ENVELOPE.md#8-decision-d4-local-admission-without-github)). Executable supervisor code must remain trusted, reviewed and pinned. It is planned, not built: no bypass is available today. GitHub-backed campaigns keep the current main-declaration route. Plan a **versioned autonomous task-graph amendment** within each approved envelope, with durable audit/admission/fencing, rather than a new approval or PR for each child. No change can widen project files, capabilities, permissions, destination, cost cap (when set), release mode or acceptance goal. Any such scope change pauses only the affected work and asks for new owner authority.

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

The existing **main-only** campaign declaration remains immutable under AW-005. Local admission from the owner's dashboard approval (decided 2026-10-16) and internal versioned task-graph amendment are recorded as a reviewed decision that preserves trusted reviewed executable code, immutable scope, provenance, audit and fencing. Ordinary in-scope decomposition/repair must not repeatedly interrupt the owner. Invalid or uncertain local file application is never silently replayed after a crash; reconcile the actual target.

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

**In short.** First, AIWorks stops losing time to its own problems: a stopped supervisor comes back by itself (#18), publishing survives a GitHub limit (#21), a pull request that conflicts after a sibling merge is repaired without a hand-written campaign (#27), and more than one step can run at a time. After that, five lanes run as parallel campaigns. Release powers are built switched off, or not built, and each row says which; the owner answered #33 D5-gate on 2026-10-17 (section 8), and lane CLN (6.8c) adds cleanup after finished work. The owner answered #24 D2 and #32 D4 on 2026-10-16 (section 8), so a project without GitHub can be planned, started and finished once lane STA and lane UI build it. Lane SELF (6.8b, added 2026-10-16) lets AIWorks maintain itself without GitHub: local main is trusted, the merge gate merges there, GitHub becomes an optional backup, and a local work list replaces AIWorks's own GitHub issues.

This section consolidates the implementation slices of the six merged designs: [PROJECT_CONNECTION](design/PROJECT_CONNECTION.md#10-implementation-slices) (PC), [WORK_ENVELOPE](design/WORK_ENVELOPE.md#12-implementation-slices) (WE), [ADAPTIVE_SCHEDULER](design/ADAPTIVE_SCHEDULER.md#10-implementation-slices) (SCH), [MODEL_ROUTING](design/MODEL_ROUTING.md#13-implementation-slices) (MR), [OWNER_WORKSPACE](design/OWNER_WORKSPACE.md#11-implementation-slices) (OW) and [AUTO_RELEASE](design/AUTO_RELEASE.md#11-implementation-slices) (AR), plus the later [SCOPED_READING](design/SCOPED_READING.md#13-implementation-slices) (SR, added 2026-10-14 as lane READ) and [LOCAL_OPERATION](design/LOCAL_OPERATION.md#9-implementation-slices) (LO, added 2026-10-16 as lane SELF). The designs hold the detail (exact tests, acceptance, reasons). This section decides order, lanes and file ownership only. It replaces the earlier wave table.

### 6.1 Where things stand (observed on main at `f912d23`, 2026-10-12)

| Item | State |
| --- | --- |
| F0-STOPPERS (#17), F1-AW005 (via I1-F1-AW005, #27 workaround), LD1-LOCAL-DATA (#16), R1-REST-PUBLISH (#21), the six designs | Merged on main (observed). Merged is not deployed: what runs on workstation is **unknown** here. |
| R2-KEEPER (#18), F2-DUPLICATE (#5 scope A), F3-CARRYOVER (#6) | Declared in `campaigns/example-reliability.json` and `campaigns/example-foundation.json`; not merged (observed). They run before every lane below. |
| #27 (conflicting published PR) | Open. Only the one-off `example-integrate-f1` workaround exists. |
| One-slot limit | Still in code: `limits.slots` must be 1 and `schedule()` stops at one open operation (observed, [SCH §3](design/ADAPTIVE_SCHEDULER.md#3-every-place-that-assumes-one-slot-and-what-replaces-it)). |
| #24, #32, #33 | Open owner decisions at that revision. #24 and #32 were answered on 2026-10-16 (section 8); #33 is still open, and its default keeps today's behaviour. |

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
| **STA** - connect projects and start work | Projects connect (GitHub, local Git, plain folder); one approval grows its own task graph. | STA1-STA18 | STA1, STA2 at once; STA3 after RUN6. |
| **UI** - owner workspace | One question per screen, project first. Every dashboard file is changed only in this lane. | UI1-UI17; UI18 (the dashboard half of lane READ, 6.8a) | At once. |
| **REL** - Auto Release, switched off | Release can be checked and rehearsed, and runs only after the rehearsal and under a grant (#33 answered 2026-10-17). | REL1-REL11, REL5a | At once (REL1). |
| **CLN** - cleanup after finished work | Finished tasks leave no worktrees and no merged local branches behind; nothing unsaved is lost. | CLN1, CLN2 | CLN1 after SELF7 (`controller.mjs` turn). |
| **PROG** - the next wave starts by itself | When a wave's last slice merges, the next unblocked slices of this plan start without a session or the owner declaring them, inside the program record the owner approved once. | PROG1-PROG5 | At once (PROG1, PROG2). |
| **READ** - scoped reading | A plan marks the sections a worker must read; the verifier reads everything and cites the rule a returned change broke; the repair round receives that section. Misses are counted, never assumed away. | READ1-READ3; UI18 runs in lane UI | READ1 at once: every earlier writer of its files is merged (observed on main at `ec7b1b3`, 2026-10-15). READ2 after READ1, READ3 after READ2, UI18 after READ3. |
| **SELF** - AIWorks maintains itself without GitHub | AIWorks's own code is trusted from local main and merged there; GitHub is an optional backup that nothing waits on; AIWorks's own findings, decisions and reviews live in a local work list. | SELF1-SELF13; UI19, UI20 run in lane UI | SELF1 at once, after `aw-ui-fix-5` (new test file only). SELF2 onwards after STA17, READ3 and the slices 6.9 names for each shared file. UI19 after UI18. |

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
| **STA4** | Local Git projects connect with a managed mirror; `startWork` is false (`LOCAL_START_OFF`). | `sup/adapters/mirror.mjs` (new), `sup/project-connect.mjs`, `ts/project-local-git.test.mjs` (new) | STA3 | PC S4 tests; owner's `.git` untouched | Connect: no. Starting work comes with STA17 (#24 and #32 answered 2026-10-16); until then `LOCAL_START_OFF`. |
| **STA5** | Plain folders connect with a managed snapshot and baselines; the source stays byte-identical. | `sup/adapters/mirror.mjs`, `ts/project-folder.test.mjs` (new) | STA4 | PC S5 tests | Same as STA4 |
| **STA6** | Task specs come from one accessor, ready for child tasks. No behaviour change. | `sup/plan.mjs` (new), `sup/store.mjs` (`task_specs`, `plan_amendments`), `sup/controller.mjs`, `sup/api.mjs`, `ts/plan-specs.test.mjs` (new) | STA5, MOD3 (api turn), MOD2 (store and controller turn), F2-DUPLICATE | WE E1 tests; no packet digest changes | No |
| **STA7** | Version 2 declarations with an `envelope` block validate; `release.mode` accepts only `review-only`. | `sup/campaign.mjs`, SUPERVISOR.md §1, `ts/envelope-schema.test.mjs` (new) | STA6, RUN4 (`writes`) | WE E2 tests; v1 digests unchanged | Built now; `auto-release` is refused until #33 (see C10). |
| **STA8** | Child tasks are admitted, chained to the envelope and idempotent across crash and retry. | `sup/plan.mjs`, `sup/controller.mjs`, `sup/work-ownership.mjs`, `ts/plan-admission.test.mjs`, `ts/plan-crash.test.mjs` (new) | STA7 | WE E3 tests: every widening refused with its code | No |
| **STA9** | Children run with their own packet binding, re-checked before every dispatch. | `sup/controller.mjs`, a new controller test file under `ts/` | STA8, RUN4 (changed paths) | WE E4 tests; declared tasks' packets byte-identical | No |
| **STA10** | AIWorks adds steps by itself and closes the outcome with a generated closing check. | `sup/adapters/executors.mjs`, `sup/controller.mjs`, `ts/envelope-e2e.test.mjs` (new) | STA9, MOD5 (controller and executors turn) | WE E5 tests; #8 acceptance "one start ... finish without the owner" | No |
| **STA11** | An approved plan starts only under its exact private approval digest and merged runtime code. | Private approvals, local loader and CLI | STA10 and merged runtime enforcement | Private approval tests | No public declaration |
| **STA12** | The owner can ask by goal, issue, PR or plan file, or plan only; drafts are never scheduled. | `sup/intake.mjs` (new), `sup/coordinator.mjs`, `sup/store.mjs` (`work_requests`, `work_drafts`), `ts/intake.test.mjs` (new) | STA11, STA1, STA4 | WE E6 tests | No |
| **STA13** | Persist private approved declarations and register them idempotently; never publish a declaration PR. | Private approval store and local loader | STA12 | Restart and digest-binding tests | Private installation data only |
| **STA14** | Local projects get verified candidates in a local ledger, never a fake PR. Inert until local admission is on. | `sup/local-candidates.mjs` (new), `sup/controller.mjs` (publish branch for local kinds), `ts/local-candidates.test.mjs` (new) | STA13, STA9, STA5 | WE E10 tests; `gh` never called | No. Merged (observed, #162); used after STA17, reviewed and applied through STA18. |
| **STA15** | AIWorks side of D2: local overlay entries validate against the schema AIWorks ships, and get every portfolio policy from the governance directory by the same derivation as a registry entry. Local admission stays off. | `schemas/local-project-overlay.schema.json` (new), `sup/local-overlay.mjs` (new), `sup/campaign.mjs` (split `governanceForContract`, same behaviour; `overlayGovernance`), `ts/local-overlay.test.mjs` (new) | STA14, STA4, READ1 (campaign turn) | PC S7 tests | No. #24 answered 2026-10-16: option 1, with the schema in AIWorks, so no governance change. |
| **STA16** | D4 local admission built and tested, switched off: the owner's dashboard approval bound to the plan's digest, a request receipt, a single-use nonce, an append-only ledger and the caller check that refuses AIWorks's own processes. No signing key. | `sup/local-admission.mjs` (new), `schemas/local-approval.schema.json` (new), `ts/local-admission.test.mjs` (new) | STA15, STA14, STA11, STA8 | WE E11 tests: every tampering and forgery case | No. #32 answered 2026-10-16. Built off; STA17 switches it on. |
| **STA17** | Work starts on projects without GitHub: an admitted dashboard approval registers the plan; reports stay local; D4 recorded. | `sup/campaign.mjs` (local target with an admitted approval), `sup/projects.mjs` and `sup/project-connect.mjs` (`startWork` for local kinds), `sup/local-admission.mjs` (on), `sup/controller.mjs` (local reports and blockers stay in the store), `docs/DECISIONS.md`, SUPERVISOR.md, `ts/local-e2e.test.mjs` (new) | STA16, UI16, READ3 (controller turn) | WE E12 full local end-to-end with a synthetic dashboard approval; no `gh` call | No owner question left (#24, #32 answered 2026-10-16). The decision record's wording is checked against the owner's words. |
| **STA18** | The owner applies a verified local result: a rescan refuses changed files, a backup is recorded first, and **Undo apply** is the way back. An owner action under Review only, not Auto Release. | `sup/release/owner-apply.mjs` (new), `ts/owner-apply.test.mjs` (new) | REL8, STA14, STA5 | WE E13 tests: Apply only on the owner route; one changed file refuses with nothing written; Undo apply; crash reconciled, never repeated; no release record or grant | No (decided 2026-10-16). Auto Release stays off (#33). |

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
| **UI13** | Add project for GitHub, local Git and plain folders, from the Projects screen. | `dash/projects.mjs`, `dash/server.mjs` (connect routes, origin, CSRF, 16 KiB), `pub/*` (Projects area), `docs/OPERATIONS_DASHBOARD.md`, `td/projects.test.mjs`, `td/connect.test.mjs` (new) | UI12, STA5 | PC S6 and OW S11 tests; no file in the folder changes on connect; no absolute path served except the owner's root | Connecting: no. Start work on a local project shows as not available until STA17 and UI17 are built. |
| **UI14** | Plan and do: Review, then Approve for a GitHub project, under AW-005. | `dash/work.mjs` (new), `dash/server.mjs`, `dash/supervisor.mjs`, `pub/*` (Start work and Review), `docs/OPERATIONS_DASHBOARD.md`, `td/approve.test.mjs` (new) | UI13, STA11, STA12 | WE E8 and OW S10 tests; no dashboard path registers what the CLI would refuse | No. #32 answered 2026-10-16: approving in the dashboard registers that exact plan, so the start needs no CLI (C3). Same checks as CLI `start`. |
| **UI15** | Release view: mode row, five-step ladder, unknown and failure lines in Needs me, **Stop all releases**; the Auto Release switch appears only with a valid grant. | `dash/supervisor.mjs`, `dash/owner.mjs`, `pub/*`, `td/release.test.mjs` (new) | UI14, REL2, REL4 | AR R9 and OW S13 tests: unknown never success; switch absent without a grant | **#33.** Built now showing Review only and Stop all releases; no grant can exist, so the switch never shows until #33. |
| **UI16** | The owner confirms, renews and revokes a local project's rules once, with a typed confirmation, valid for up to 12 months. | `dash/projects.mjs`, `dash/server.mjs` (rules routes with origin, CSRF, 16 KiB and the caller check), `pub/*` (rules review), `td/projects.test.mjs` | UI15, STA15, STA16 (caller check) | PC S8 tests; no worker or coordinator path writes overlays; a request from a synthetic AIWorks process is refused | No. #24 answered 2026-10-16. |
| **UI17** | Plan, approve and apply for projects without GitHub: *Confirm this project's rules*, *Approve and start*, *Ready for your review*, then **Apply** and **Undo apply**. | `dash/work.mjs`, `dash/server.mjs` (approve and apply routes with the caller check), `pub/*` (local project screens), `docs/OPERATIONS_DASHBOARD.md`, `td/local.test.mjs` (new) | UI16, UI14 (`dash/work.mjs`), STA17, STA18 | OW S12 tests: no PR ever shown; Apply refused on a changed folder with nothing written; Undo apply restores the folder; an approval or Apply from a synthetic AIWorks process refused; keyboard and 320px | No. Decided 2026-10-16 (#24, #32, results by Apply). Apply is an owner action under Review only, not Auto Release. |

After UI9, run the blind review of [OW §13](design/OWNER_WORKSPACE.md#13-blind-review-protocol-ux-002-pass-a) (pass A, then B, B2, C). Findings become fix PRs in this lane. #11 is accepted only with no blocker or must finding open. This is a gate, not a slice.

### 6.8 Lane REL - Auto Release, switched off

Every slice ships with `release.enabled: false` (AR §11). #33 was answered on 2026-10-17 (section 8 (h) to (k)): no release credential is ever created, and REL11 is the first slice that switches anything on.

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **REL1** | AIWorks reads and validates a standing release record and says why one is invalid. Nothing acts on it. | `schemas/release-authorization.schema.json` (new), `sup/release/authorization.mjs` (new), `ts/release-authorization.test.mjs` (new) | none | AR R1 tests | Built off (#33) |
| **REL2** | Status reports, per done task and destination, "would be eligible" or "not eligible, because ...". Report only. | `sup/release/classify.mjs`, `sup/release/eligibility.mjs` (new), `sup/api.mjs` (`release` field), `ts/release-eligibility.test.mjs` (new) | REL1, RUN3 (api turn) | AR R2 tests: every check fails on missing or unknown evidence | Built off (#33) |
| **REL3** | Durable release rows, one lock per destination, intent before effect, reconciliation with a fake adapter. | `sup/store.mjs` (`releases`, `release_locks`), `sup/release/state.mjs` (new), `ts/release-state.test.mjs` (new) | REL2, RUN5 (store turn) | AR R3 tests | Built off (#33) |
| **REL4** | `RELEASE-STOP`, per-project mode (default Review only) and `release.enabled` checked before every step; CLI `release-stop`, `release-mode ... review-only`. | `sup/release/state.mjs`, `sup/cli.mjs`, `sup/api.mjs`, SUPERVISOR.md (release section, "built, not enabled"), `ts/release-switches.test.mjs` (new) | REL3, MOD1 (cli turn) | AR R4 tests; no command can switch a project to Auto Release | Built off (#33) |
| **REL5** | A release step runs in its own clean process; the credential is fetched by reference only. | `sup/release/runner.mjs`, `sup/release/credential.mjs` (new), `ts/release-runner.test.mjs` (new), a static test under `ts/` that merge, deploy and apply calls live only in `sup/release/` | REL4 | AR R5 tests; synthetic credential never in journal, row, log or packet | Built off. #33 item 2 answered 2026-10-17 (i): no release credential; REL5a changes the runner. |
| **REL5a** | A destination names no credential: the runner uses the logins already on this computer (the operator's `gh` login for a merge; the project's commands with the access they already have), still in its own clean process with only the variables those logins need. New destination kind `deploy`: it deploys the merge commit the merge gate recorded and never merges; a `merge` or `merge-then-deploy` destination in a repository the merge gate covers is invalid. | `schemas/release-authorization.schema.json`, `sup/release/authorization.mjs`, `sup/release/eligibility.mjs`, `sup/release/runner.mjs`, `ts/release-authorization.test.mjs`, `ts/release-eligibility.test.mjs`, `ts/release-runner.test.mjs` | REL5 | AR R1, R2 and R5 tests kept, plus: no credential store is read; the runner never sets `GH_TOKEN`; a merge destination in a merge-gate repository is refused by name; a `deploy` release without a recorded `merged` event is not eligible | No (decided 2026-10-17 (i), (k)) |
| **REL6** | GitHub merge adapter: `--match-head-commit`, tree equality, reconciliation, revert-PR proposal. | `sup/release/github-merge.mjs` (new), `sup/adapters/github.mjs` (read-only `pullRequestState`), `ts/release-github.test.mjs` (new) | REL5, STA13 (github.mjs turn) | AR R6 tests: never two merge calls for one release | Deferred (k): built only when a project wants releases without the merge gate. The merge gate's own call (`github-merge.mjs`, #138) is not this slice. |
| **REL7** | Deploy, check and rollback through the project's own commands at the exact revision, with drift check and automatic rollback; for kind `deploy`, the revision is the merge commit the merge gate recorded, after the tree check of AR §7.2 step 3. | `sup/release/deploy.mjs` (new), `ts/release-deploy.test.mjs` (new) | REL5a | AR R7 tests; a `deploy` release whose merge commit's tree differs from the verified tree is refused | Built off; a real destination waits for REL11 |
| **REL8** | `local-git-apply` and `local-folder-apply` with backup, apply, confirm, rollback and reconciliation. First used by the owner's Apply (STA18). | `sup/release/local-apply.mjs` (new), `ts/release-local.test.mjs` (new) | REL4, STA5 | AR R8 tests, none skipped on Windows | No to build or for the owner's Apply (decided 2026-10-16). A local **Auto Release** grant waits for #33. |
| **REL9** | The release decision and its three cross-references are recorded with the next free AW number (C2). | `docs/DECISIONS.md`, `docs/PRODUCT_CONSTITUTION.md`, `AGENTS.md`, `docs/STATUS.md` | REL7, F3-CARRYOVER (REL8 not needed) | `npm run check`; text matches the owner's accepted wording | #33 item 1 answered 2026-10-17 (h). Records AW-010 with (i) to (m), including the cleanup sentence of AW-001 (l). |
| **REL10** | the governance contract's project-contract schema accepts the release executor and record; AIWorks's registry entry carries it. **An governance pull request by the governance contract's process, proposed from here as text only.** | In `example-org/governance`: `schemas/project-contract.schema.json`, `registry/projects/aiworks.json` | REL9 | the governance contract's own validation | #33 answered 2026-10-17; the proposal carries (i) (no credential field) and (k) (kind `deploy`). Governance review still needed. |
| **REL11** | Disposable rehearsal on workstation, then one granted canary. Runbook only. | SUPERVISOR.md (enable and roll back), `docs/STATUS.md` | REL1-REL5, REL5a, REL7, REL9, REL10 merged and deployed (REL8 for a local canary, UI15 recommended) | Full suite at the deployed SHA; forced check failure with rollback; controller killed mid-merge and mid-deploy | #33 answered 2026-10-17: the rehearsal, then the canary of (j). The canary's grant record carries the owner's approval link (AR §4.2 `approval`). |

Since 2026-10-17 no slice in this lane waits for an owner answer. The one owner act left is approving the canary's grant record in REL11. REL8 is already merged; the owner's Apply (STA18) uses it.

### 6.8a Lane READ - scoped reading and verifier citations

Added 2026-10-14 from [SCOPED_READING](design/SCOPED_READING.md). A task reference may name one section of a Markdown document (`docs/SUPERVISOR.md#3-lifecycle-of-one-task`); the controller resolves it at the pinned revision into a reading guide for the prompt, and an anchor that does not resolve widens to the whole document and is journalled, never blocks. The verifier reads every referenced document in full and cites the section a blocking finding rests on; the repair packet carries that section as a reference and in the finding text; later siblings in the same campaign get it in their guide. The packet schema, the worker-context policy and every anchor-free declaration's digests are unchanged. No saving is claimed: `supervisor baseline` reports the miss and fallback counts and compares cohorts only when both have five finished tasks. Seven further improvements are written and parked in [SR §10](design/SCOPED_READING.md#10-parked-written-not-built) with the evidence that would un-park each.

Nothing in this lane is built (planned). Every slice it waits for (STA8, STA10, MOD5, MOD6, UI12) is merged on main, and so are STA12 and STA14, which changed `sup/coordinator.mjs`, `sup/controller.mjs` and `sup/api.mjs` after the design was first written (observed at `ec7b1b3`, 2026-10-15; merged is not deployed). STA10 put the planning-step prompt in `sup/adapters/executors.mjs` (`PLAN_RULE`), so READ3 also writes that file. UI18 changes dashboard files, so it runs in lane UI (6.7) and is listed here for the outcome.

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **READ1** | `path#anchor` validates in declarations and child amendments; a pure resolver (slugs, headings, extents) exists. No behaviour change. | `sup/reading.mjs` (new), `sup/campaign.mjs` (reference rule), `sup/plan.mjs` (A5), SUPERVISOR.md §1, `ts/reading.test.mjs` (new) | STA8 | SR §13 READ1: slugs of every design document's headings match their own links; exact, unique-prefix, ambiguous and missing anchors; secret-like behind an anchor refused; every synthetic fixture's digests unchanged | No |
| **READ2** | Dispatch resolves anchors into a reading guide; implementer and verifier prompts carry the SR §5 wording; verifier findings may cite `path#anchor`; cites of blocking findings reach the repair packet; brokered research reads the path part. | `sup/controller.mjs`, `sup/adapters/claude.mjs`, `sup/adapters/executors.mjs`, `sup/adapters/research-context.mjs`, `ts/reading-dispatch.test.mjs` (new) | READ1, STA10 and STA14 (controller turn; STA10 also executors), MOD5 | SR §13 READ2: heading moved between two commits resolves then falls back; anchor-free packets and prompts byte-identical; a bad cite never invalidates a verdict; cap by priority; `covered`, `section-miss`, `unreferenced-doc` classified | No |
| **READ3** | Siblings in one campaign inherit cited sections in their guide (prompt only); the coordinator and the planning step mark sections; status and baseline report the counts. | `sup/controller.mjs`, `sup/coordinator.mjs` (both drafting prompts), `sup/adapters/executors.mjs` (`PLAN_RULE`, the STA10 planning prompt), `sup/api.mjs` (`reading` per task), `sup/baseline.mjs` (`aiworks-baseline/2`), `ts/coordinator.test.mjs`, `ts/status.test.mjs`, `ts/baseline.test.mjs` | READ2, MOD6 and STA14 (api turn; MOD6 also status test), STA10 (plan prompt), STA12 (coordinator turn) | SR §13 READ3: carry-forward only to section-referencing siblings, bounded 4 per document and 8 per dispatch, packet digests unchanged; "not comparable" below five finished tasks per cohort; store byte-identical after `baseline` | No |
| **UI18** | The Step screen says which rule a returned change broke and which sections the next attempt was given. | `dash/supervisor.mjs`, `dash/copy.mjs`, `pub/dashboard.js`, `td/work.test.mjs` | READ3, UI12 | SR §13 UI18: copy for fallbacks, misses and extensions; nothing shown for `reading: null`; no document text served | No |

### 6.8b Lane SELF - AIWorks maintains itself without GitHub

Added 2026-10-16 from [LOCAL_OPERATION](design/LOCAL_OPERATION.md) for the owner's decisions (e) and (f) (section 8). The design lists every GitHub call in `src/` and `scripts/` with the slice that removes it or makes it optional ([LO §3](design/LOCAL_OPERATION.md#3-every-place-aiworks-calls-github-today)). Only AIWorks's own repository is affected, and only once `config.json` `selfHosting.trustedMain` is `"local"`; every other project keeps today's behaviour. A **main ledger** in the store records each commit the merge gate puts on local `main`, so a worker that moves `main` by hand cannot make its code trusted ([LO §4.2](design/LOCAL_OPERATION.md#42-the-main-ledger)). The amended AW-001, AW-005, AGENTS.md and runbook text ([LO §8](design/LOCAL_OPERATION.md#8-proposed-amended-text)) land with SELF12, before SELF13 switches anything on.

Nothing in this lane is built (planned). The UI halves, UI19 and UI20, change dashboard files, so they run in lane UI and are listed here for the outcome.

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **SELF1** | A static test lists every GitHub call site; a new one fails with its `file:line`. Later SELF slices shrink the list. | `ts/github-boundary.test.mjs` (new) | none | LO L1: the scanner first catches planted `gh api`, `fetch origin`, `push origin`, `ls-remote origin` calls; then the tree matches the list | No |
| **SELF2** | `selfHosting` validates; the main ledger and the trusted tip exist. Off by default. | `sup/self-hosting.mjs` (new), `sup/store.mjs` (`main_ledger`, additive), `ts/self-hosting.test.mjs` (new) | SELF1, STA12 (store turn, merged) | LO L2: malformed is off; anchor only equal to `origin/main` and local `main`; unrecorded commits; `MAIN_REWRITTEN` | No |
| **SELF3** | Runtime provenance against the trusted tip of local main; CLI `trusted-main`. Off: messages byte-identical. | `sup/provenance.mjs`, `sup/cli.mjs`, `sup/controller.mjs` (AW-005 texts only), `sup/coordinator.mjs` (one text), `ts/provenance-local.test.mjs` (new) | SELF2, STA17 (controller turn), READ3 (coordinator turn), STA11 (cli turn) | LO L3: passes with no `origin` remote; a forged `update-ref` from a worker worktree is not trusted; no fetch | No (decided 2026-10-16 (e)) |
| **SELF4** | Bases, worktrees, dependency integration and the project check of the self-hosted repository use local refs and the ledger: no `gh`, no fetch; `ciRepair` refused for it. | `sup/controller.mjs`, `sup/adapters/git.mjs`, `sup/intake.mjs` (base pin), `sup/project-connect.mjs` (check without `gh`), `ts/local-base.test.mjs` (new) | SELF3, STA17 (`project-connect.mjs` turn), RUN4 (`git.mjs`, merged) | LO L4: a full implement, verify and repair cycle in a repository with no remote; a fake `gh` fails the test if run | No |
| **SELF5** | The local work list: items, append-only comments, numbering that keeps imported issue numbers, bounds, secret check; CLI `work-list`. | `sup/work-list.mjs` (new), `sup/store.mjs` (`work_items`, `work_item_comments`), `sup/cli.mjs`, `ts/work-list.test.mjs` (new) | SELF2 (store turn), SELF3 (cli turn) | LO L5 | No (decided 2026-10-16 (f)) |
| **SELF6** | Workers, research snapshots, the coordinator and intake read the work list through a scoped local reader for the self-hosted repository. | `sup/work-list-reader.mjs` (new), `sup/adapters/executors.mjs`, `sup/adapters/claude.mjs`, `sup/adapters/research-context.mjs`, `sup/coordinator.mjs`, `sup/intake.mjs` (issue route), `ts/work-list-reader.test.mjs` (new) | SELF5, SELF4 (intake turn), SELF3 (coordinator turn), READ3 (executors turn), READ2 (claude and research-context turn) | LO L6: scope fixed at run start; no write; packet digests and other repositories' prompts byte-identical | No |
| **SELF7** | Publication, reports, repair notes, outbox and blockers of the self-hosted repository go to the work list, with no push and no `gh`; review campaigns record reports there; `aiworks-work:<n>` authorization accepted, off until STA17 is on. | `sup/controller.mjs` (`publish`, `enqueue`, `drainOutbox`), `sup/campaign.mjs`, `sup/owner-intervention.mjs` (link), `ts/local-review.test.mjs` (new) | SELF6, SELF4 (controller turn), STA17 (campaign turn) | LO L7: crash after recording leaves one item; a report over 65,536 characters stored whole; GitHub targets byte-identical | No. The local authorization form switches on with STA17 (#32 answered 2026-10-16). |
| **SELF8** | The local merge gate, built off: merge commit made locally with the trusted tip and the verified head as parents and the verified tree; `main` moved only from the trusted tip; ledger row. | `sup/merge.mjs`, `sup/release/local-merge.mjs` (new), `ts/local-merge.test.mjs` (new), SUPERVISOR.md (merge gate, local form) | SELF7, SELF3 | LO §6 rows for SELF8: base moved means repair; tree mismatch refused; crash leaves one merge commit; dirty checkout waits; `ts/release-boundary.test.mjs` unchanged | No to build. Turning it on is SELF13. |
| **SELF9** | Optional GitHub backup of trusted `main`, never forced, nothing waits on it; status shows trusted tip, unrecorded commits and backup. | `sup/github-backup.mjs` (new), `sup/merge.mjs`, `sup/api.mjs` (`selfHosting`), `ts/github-backup.test.mjs` (new), `ts/status.test.mjs` | SELF8, READ3 (api and status-test turn) | LO L9: bare-repository remote; no force argument; refused and unreachable remotes reported and the next merge still happens | No to build. Off until SELF13. |
| **SELF10** | One-time import of the open GitHub issues and all their comments, read-only towards GitHub. | `sup/work-list-import.mjs` (new), `sup/cli.mjs` (`work-list import`, dry run by default), `ts/work-list-import.test.mjs` (new) | SELF5 | LO L10: fake `gh` sees only `GET`; pull requests skipped; numbers kept; re-run idempotent | No (decided 2026-10-16 (f)) |
| **SELF11** | After the owner confirms the list in the dashboard, each imported issue that has not changed gets one pointer comment and is closed on GitHub. | `sup/work-list-import.mjs`, `sup/adapters/github.mjs` (`closeIssue`), `ts/work-list-import.test.mjs` | SELF10, STA16 (caller check) | LO L11: only the confirmed list; changed issue skipped; no second comment after a crash; synthetic AIWorks caller refused | Built now; it closes issues only after the owner's confirmation in UI20 and the amended AW-001 of SELF12. |
| **SELF12** | The amended AW-001, AW-005, AGENTS.md and runbook text land; `deploy.ps1 -Main local` pins the trusted tip and keeps the current governance checkout if its pull fails. | `docs/DECISIONS.md`, `docs/PRODUCT_CONSTITUTION.md`, `AGENTS.md`, SUPERVISOR.md, `scripts/supervisor/deploy.ps1`, `docs/STATUS.md` | SELF3-SELF11, UI19, UI20 | `npm run check`; text checked against the owner's words of 2026-10-16; verified-tree, merge-commit and merged-runtime rules not weakened | No new question; records decisions (e) and (f). |
| **SELF13** | AIWorks runs from local main: disposable rehearsal, then the switch on workstation through the upgrade procedure. Runbook only. | SUPERVISOR.md (switch on, switch back), `docs/STATUS.md` | SELF12 merged and deployed | Full suite at the deployed SHA; a whole task cycle with `gh` off `PATH`; status before and after | No new question: the owner sets `selfHosting` and the merge-gate opt-in in `config.json`, as for the merge gate today. |
| **UI19** | Dashboard: Resume checks the trusted tip; merge check of the self-hosted repository reads local `main` without fetch; Settings shows trusted main and backup; links point into the work list. | `dash/supervisor.mjs`, `dash/merges.mjs`, `dash/owner.mjs`, `dash/copy.mjs`, `pub/dashboard.js`, `td/self-hosting.test.mjs` (new) | UI18, SELF3, SELF9 | LO L12: no `git fetch` for the self-hosted repository; Resume refused on an unrecorded runtime; keyboard and 320px | No |
| **UI20** | Dashboard: the work list screen, owner decisions in Needs me, review items in Results, import and the confirmed close. | `dash/work-list.mjs` (new), `dash/server.mjs` (routes with origin, CSRF, 16 KiB and the caller check), `dash/owner.mjs`, `pub/*`, `docs/OPERATIONS_DASHBOARD.md`, `td/work-list.test.mjs` (new) | UI19, SELF5, SELF10, SELF11, STA16 | LO L13: workers cannot write; close only after the typed confirmation; plain copy | No |

### 6.8c Lane CLN - cleanup after finished work

Added 2026-10-17 for the owner's decision (l) (section 8). Today nothing removes a worktree or a branch (observed: `sup/adapters/git.mjs:3`, SUPERVISOR.md section 1), so every task leaves its implementer and verifier checkouts and its local branch behind. Nothing in this lane is built (planned), and nothing is cleaned before CLN2.

A task is **finished** for cleanup when the trusted main (`origin/main`, or local main once SELF13 is on) contains its verified commit, or when its campaign is completed or cancelled, and it has no open operation.

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **CLN1** | Cleanup, built off (`cleanup.enabled` in `config.json`; absent or malformed means off). Once per pass, for each finished task: remove each of its worktrees with `git worktree remove`, never `--force`; keep and report one with uncommitted or untracked files; then delete its local `campaign/<campaign>/<task>` branch with `git branch -d` only when the trusted main contains it. Coordinator and planning checkouts of finished runs follow the same rule. A worktree no task or run owns is kept and listed. It never deletes a remote branch, a run directory or anything outside the registered worktree folder. Each removal is journaled before and after, so a crash resumes and never repeats. | `sup/cleanup.mjs` (new), `sup/adapters/git.mjs` (remove and delete helpers), `sup/controller.mjs` (one call per pass), SUPERVISOR.md (cleanup, "built, not enabled"), `ts/cleanup.test.mjs` (new) | SELF4 (`git.mjs` turn), SELF7 (`controller.mjs` turn) | A worktree with changes is kept and reported; a branch main does not contain is kept; an open operation's worktree is never touched; a path outside the registered folder is refused; a crash between removal and branch deletion finishes once; a later repair round recreates a removed worktree; `ts/release-boundary.test.mjs` unchanged | No (decided 2026-10-17 (l)). Switched on only by CLN2. |
| **CLN2** | Baseline, then switch on through the upgrade procedure: record privately the number and size of worktrees and local task branches, set `cleanup.enabled: true`, and compare after the first passes, which also clear the backlog of earlier tasks. Runbook only. | SUPERVISOR.md (switch on, switch back), `docs/STATUS.md` | CLN1 merged and deployed; REL9 merged (the amended AW-001 sentence) | Full suite at the deployed SHA; counts before and after; every kept worktree still has its files | No new question (l) |

### 6.8d Lane PROG - the next wave starts by itself

Added 2026-10-17 for the owner's decision (n) (#153 option B, section 8). Today a wave ends and AIWorks goes idle until a session writes the next declarations and someone runs `start` (observed, #153). Nothing in this lane is built (planned).

**The program record.** One private JSON file, `aiworks-program/1`, kept outside source Git like an envelope approval (`sup/approvals.mjs`). It names:
- the repository and base branch;
- the plan file;
- `allow`, the slice IDs or lane prefixes it covers, and `exclude`, the slices it never covers;
- the executor chain and the constraints every task carries, copied into each declaration unchanged;
- an `authorization` block with the owner's words and a version that only goes up.

The store keeps its canonical digest. A newer version replaces it; `revoked: true` or a `PROGRAM-STOP` file in the data directory stops every new wave at once.

**A wave, by fixed rules.** At most once an hour, and only while no wave of the program has unfinished tasks, the supervisor reads this plan from the trusted main. A slice is **ready** when all of these hold:
- the record allows it and does not exclude it;
- its row is not runbook-only;
- no task with its ID is done or running in this repository;
- every slice ID in its *Depends on* cell is done, with its verified commit on main;
- no earlier slice in the turn order (6.9) that writes one of its files is unfinished.

The ready slices become one version 1 declaration, `<program>-w<n>`:
- each task's goal is its row: outcome, files, dependencies and tests, with the section it comes from;
- `writes` are the files its *Owns* cell names;
- `dependsOn` links slices of the same wave;
- `requiresMergedDependencies` is true.

The same plan revision and record always give the same declaration and digest.

**Registration.** The supervisor registers a wave only if every task fits the record exactly and the runtime passes the AW-005 merged-code check. It journals `program-registered` with both digests, and Results shows it. A wave that does not fit is not registered: it becomes one Needs me item with the reason and the proposed declaration. Registration is idempotent across restarts, so one wave number is never registered twice.

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **PROG1** | The program record validates and is stored by digest; CLI `program-approve <file>`, `program-stop` and `program-status`. Built off: `program.enabled` in `config.json`, absent or malformed means off. | `schemas/program-record.schema.json` (new), `sup/program.mjs` (new), `sup/cli.mjs`, `ts/program.test.mjs` (new) | none | An unknown field, a missing field or a lower version is refused without echoing the file; a newer version replaces the old one; revoked stays revoked; `PROGRAM-STOP` is read without the database; nothing is registered by this slice | No (decided 2026-10-17 (n)) |
| **PROG2** | The wave proposal: plan rows, turn order and shared-file lists parsed from the plan text; ready slices computed by the rules above; one declaration built that `validateDeclaration` accepts. Pure: reads text and task facts, writes nothing. | `sup/program-plan.mjs` (new), `ts/program-plan.test.mjs` (new, a synthetic plan fixture) | none | A slice with an unfinished dependency, an earlier unfinished writer of the same file, a runbook-only row, an excluded slice or a running task is not proposed, each with its reason; the same inputs give the same digest; this plan parses without error | No |
| **PROG3** | Registration in the supervisor pass, built off: one wave at a time, the exact-fit check, the journal event, Needs me on a misfit, `PROGRAM-STOP` and crash safety. | `sup/program.mjs`, `sup/controller.mjs` (one call per pass), SUPERVISOR.md (program section, "built, not enabled"), `ts/program-register.test.mjs` (new) | PROG1, PROG2 | Off: nothing registered and status unchanged; on: a fitting wave registered once, also after a crash between registration and journal; a misfit becomes one Needs me item and registers nothing; a wave never starts while an earlier wave has unfinished tasks | No |
| **PROG4** | The decision text: (n) recorded with the next free AW number, and the constitution sentence "runs only campaigns the owner explicitly registered" amended to include waves registered under an owner-approved program record. | `docs/DECISIONS.md`, `docs/PRODUCT_CONSTITUTION.md`, `AGENTS.md`, `docs/STATUS.md` | PROG3, REL9 | `npm run check`; the text quotes the owner's words of 2026-10-17 | No |
| **PROG5** | Switch on: the owner's first program record, approved with `program-approve`, then `program.enabled: true` through the upgrade procedure. Runbook only. | SUPERVISOR.md (switch on, switch back) | PROG1-PROG4 merged and deployed | Status before and after; the first wave proposed from main matches a hand check of section 6 | No new question (n) |

### 6.9 Shared files and the order that avoids conflicts

Files touched by one lane only (for example `sup/scheduler.mjs`, `sup/router.mjs`, `sup/release/*`, `sup/adapters/mirror.mjs`, everything under `src/dashboard/`) follow the lane order. Files touched by more than one lane, or by a declared task and a lane, follow this global turn order. A slice starts only after every earlier slice in the list that touches the same file is merged:

**Turn order:** R2-KEEPER → F2-DUPLICATE → F3-CARRYOVER → RUN1 → RUN1B → STA1 → MOD1 → RUN2 → RUN3 → REL2 → RUN4 → RUN5 → REL3 → REL4 → RUN6 → RUN9 → STA3 → MOD2 → MOD3 → STA6 → STA7 → STA8 → STA9 → MOD5 → MOD6 → STA10 → STA11 → STA12 → STA13 → REL6 → STA14 → RUN10 → MOD7 → STA15 → STA16 → PROG1 → PROG3 → STA17 → SELF2 → SELF3 → SELF4 → SELF5 → SELF6 → SELF7 → CLN1 → SELF8 → SELF9 → SELF10 → SELF11 → SELF12 → SELF13 → REL9 → PROG4 → CLN2 → REL11.

**Lane SELF (added 2026-10-16).** SELF1 creates one test file, so it waits for no other slice; like every slice it starts after campaign `aw-ui-fix-5` (decision (g)). Every later SELF slice that changes `ts/github-boundary.test.mjs` takes it in lane order. SELF2 to SELF13 sit after STA17 and before REL9 and REL11: a SELF slice never waits for them. #33 was answered on 2026-10-17, so if REL9 is ready before SELF12, REL9 may go first; both then edit `docs/DECISIONS.md`, `AGENTS.md` and `docs/PRODUCT_CONSTITUTION.md` one after the other, and the second keeps the first one's text. `sup/merge.mjs` (merged with the merge gate, #138) and the new files of the lane are written by lane SELF only. UI19 follows UI18, and UI20 follows UI19, in lane UI.

**Local projects (re-checked 2026-10-16).** STA15 takes its `sup/campaign.mjs` turn after READ1; STA17 takes its `sup/campaign.mjs` turn after STA15 and its `sup/controller.mjs` turn after READ3. STA16 and STA18 create new files only, so they follow their lane order: STA18 after REL8, which is lane REL's only file. `sup/projects.mjs` and `sup/project-connect.mjs` are lane STA files (STA1, STA3, STA4, STA5, then STA17). The dashboard halves run in lane UI: UI16 after STA16, UI17 after STA17 and STA18. The owner also decided on 2026-10-16 that campaign `aw-ui-fix-5` runs first, before any of these slices.

**Lane READ (added 2026-10-14, re-checked against main at `ec7b1b3` on 2026-10-15)** joins the order after STA14: READ1 → READ2 → READ3, each after the slice above that last touched its files. Every earlier writer of a READ file is merged (observed). READ1 touches `sup/campaign.mjs` after STA7 and before STA15, `sup/plan.mjs` after STA8 and SUPERVISOR.md after STA7 and before RUN10. READ2 touches `sup/controller.mjs` after STA14 and `sup/adapters/executors.mjs` after STA10. READ3 touches `sup/controller.mjs` and `sup/adapters/executors.mjs` after READ2, `sup/api.mjs` after STA14, `ts/status.test.mjs` after MOD6 and `sup/coordinator.mjs` after STA12. STA14 merged first (#162), so its controller turn comes before READ2 and READ3.

| Shared file | Writers, in order |
| --- | --- |
| `sup/controller.mjs` | RUN1, RUN1B, RUN2, RUN3, RUN4, RUN5, RUN6, STA3, MOD2, STA6, STA8, STA9, MOD5, STA10, STA14, READ2, READ3, PROG3, STA17, SELF3, SELF4, SELF7, CLN1 |
| `sup/store.mjs` | F2-DUPLICATE, STA1, RUN2, RUN3, RUN5, REL3, MOD2, STA6, STA12, SELF2, SELF5 |
| `sup/api.mjs` | R2-KEEPER, F2-DUPLICATE, RUN1B, RUN2, RUN3, REL2, REL4, RUN9, MOD3, STA6, MOD6, STA14 (observed: #162 changed it), READ3, SELF9 |
| `sup/campaign.mjs` | F2-DUPLICATE, RUN4, STA3, MOD3, STA7, READ1, STA15, STA17, SELF7 |
| `sup/plan.mjs` | STA6 (creates), STA8, READ1 |
| `sup/coordinator.mjs` | STA12, READ3, SELF3, SELF6 |
| `sup/baseline.mjs` | MOD1 (creates), READ3 |
| `sup/adapters/claude.mjs` | READ2, SELF6 |
| `sup/adapters/research-context.mjs` | READ2, SELF6 |
| `sup/cli.mjs` | R2-KEEPER, MOD1, REL4, STA11, PROG1, SELF3, SELF5, SELF10 |
| `sup/work-ownership.mjs` | F2-DUPLICATE (creates), RUN4, STA8 |
| `sup/adapters/github.mjs` | R1-REST-PUBLISH (merged), RUN1B, STA13, SELF11, REL6 (deferred) |
| `sup/adapters/executors.mjs` | MOD5, STA10, READ2, READ3, SELF6 |
| `ts/helpers.mjs` | R2-KEEPER, RUN1, STA13 |
| `ts/status.test.mjs` | RUN9, MOD6, READ3, SELF9 |
| `dash/supervisor.mjs` | R2-KEEPER, then lane UI only |
| `docs/SUPERVISOR.md` | R2-KEEPER, F2-DUPLICATE, F3-CARRYOVER, RUN1, RUN1B, MOD1, RUN3, RUN4, RUN5, REL4, MOD3, STA7, READ1, RUN10, MOD7, PROG3, STA17, CLN1, SELF8, SELF12, SELF13, CLN2, REL11, PROG5 |
| `docs/STATUS.md` | F3-CARRYOVER, RUN10, MOD7, SELF12, SELF13, REL9, PROG4, CLN2, REL11 |
| `docs/DECISIONS.md` | F3-CARRYOVER, STA17, SELF12, REL9, PROG4 |
| `AGENTS.md`, `docs/PRODUCT_CONSTITUTION.md` | SELF12, REL9, PROG4 (REL9 and SELF12 in either order, see lane SELF above; PROG4 after REL9) |
| `sup/adapters/git.mjs` | RUN1, RUN4, SELF4, CLN1 |
| `sup/intake.mjs` | STA12 (creates), SELF4, SELF6 |
| `sup/project-connect.mjs` | STA3 (creates), STA4, STA5, STA17, SELF4 |
| `sup/merge.mjs` | MERGE-GATE (merged, #138), SELF8, SELF9 |
| `scripts/supervisor/deploy.ps1` | SELF12 |

Two cases need the order spelled out:

- **`controller.mjs` is the bottleneck.** Twenty-two slices change it (fifteen before lane READ, then READ2, READ3, STA17, SELF3, SELF4, SELF7 and CLN1), one at a time. RUN goes first because parallel work and conflict repair speed up every later slice. Meanwhile the other lanes do their slices that avoid it: STA1, STA2, MOD1, MOD4, REL1 to REL5, REL7 and all of lane UI.
- **STA17 and REL9 both append a decision.** Both owner answers are in (2026-10-16 for STA17, 2026-10-17 for REL9). The listed order holds; if REL9 is ready first, REL9 may go first, and STA17 then starts after REL9 is merged. Both only append a new record.

### 6.10 What waits for an owner decision

**#24 and #32 were answered on 2026-10-16** (section 8). Nothing for projects without GitHub waits for the owner any more: STA15 to STA18, UI16, UI17 and REL8 wait only for the slices they depend on. Until STA17 is built and deployed, local projects connect and plan but cannot start (`LOCAL_START_OFF`, observed in `src/supervisor/campaign.mjs:355-358`).

| Decision | Built switched off meanwhile | Stays off or unbuilt until answered |
| --- | --- | --- |
| #33 D5-gate - Auto Release, **answered 2026-10-17** (section 8 (h) to (k)) | REL1-REL7 and REL5a (`release.enabled: false`, never a credential); UI15 (Review only, Stop all releases, no switch without a grant); STA7 refuses `auto-release` | Nothing waits for an answer. A real grant exists only from REL11, after the rehearsal, with the owner's approval link in the grant record. The owner's own Apply (STA18) is Review only. |
| #153 - waves start by themselves, **answered 2026-10-17** (section 8 (n)) | PROG1-PROG3 (`program.enabled` off) | Nothing waits for an answer. PROG5 switches it on with the owner's first program record. |

Lane SELF waits for no owner decision: the owner answered (e) and (f) on 2026-10-16. Its powers are built switched off and SELF13 switches them on through the upgrade procedure once the owner sets `selfHosting` in `config.json`. Its local authorization form (`aiworks-work:<n>`) stays off until STA17 turns local admission on, and imported issues are closed on GitHub only after the owner confirms the list in the dashboard (SELF11, UI20).

Telegram delivery (#1) has no slice in this order and stays off. Needs me stays the one source it would later send.

### 6.11 Design slice → build-order slice

Every design slice appears once. "Merged" means two design slices became one build slice; "split" means one design slice has a supervisor half and a dashboard half.

| Design | Mapping |
| --- | --- |
| SCH | S1→RUN3, S2→RUN2, S3→RUN4, S4→RUN5, S5→RUN7, S6→RUN8, S7→RUN6, S8→RUN9 + UI11 (split), S9→RUN10 |
| MR | R1→MOD1, R2→MOD2, R3→MOD3, R4→MOD4, R5→MOD5, R6→MOD6 + UI12 (split), R7→MOD7 |
| PC | S1→STA1, S2→STA2, S3→STA3, S4→STA4, S5→STA5, S6→UI13 (merged with OW S11), S7→STA15, S8→UI16 |
| WE | E1→STA6, E2→STA7, E3→STA8, E4→STA9, E5→STA10, E6→STA12, E7→STA11, E8→UI14 (merged with OW S10), E9→STA13, E10→STA14, E11→STA16, E12→STA17, E13→STA18 |
| OW | S0→UI1, S1→UI2, S2→UI3, S3→UI4, S4→UI5, S5→UI6, S6→UI7, S7→UI8, S8→UI9, S9→UI10, S10→UI14 (merged), S11→UI13 (merged), S12→UI17, S13→UI15 (merged with AR R9) |
| AR | R1→REL1, R2→REL2, R3→REL3, R4→REL4, R5→REL5, R6→REL6, R7→REL7, R8→REL8, R9→UI15 (merged), R10→REL9, R11→REL10, R12→REL11 |
| Issue #27 (no design slice) | RUN1 (gap G1) |
| SR | READ1→READ1, READ2→READ2, READ3→READ3, UI18→UI18 (dashboard half, lane UI); SR §10 P1-P7 parked, no slice |
| LO | L1→SELF1, L2→SELF2, L3→SELF3, L4→SELF4, L5→SELF5, L6→SELF6, L7→SELF7, L8→SELF8, L9→SELF9, L10→SELF10, L11→SELF11, L12→UI19 (dashboard half, lane UI), L13→UI20 (dashboard half, lane UI), L14→SELF12, L15→SELF13 |

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
| C3 | OW Q1 and WE §11 Q2 ask the owner whether approving in the dashboard counts as registering the plan. #32 lists the same point as "already decided, not asked" (plan §3.2, §4, D3). | **Answered by the owner on 2026-10-16:** approving a plan in the local dashboard registers exactly that plan, bound to its digest. UI14 starts a GitHub project's work without the CLI; STA17 and UI17 do the same for a local project. | The owner's decision closes it; both designs now say so (WE §11). |
| C4 | Who builds the Review-only local "Apply"? AR §4.1 says #7; PC §10 says #13 and #8; WE §12 says #13. No design had a slice for it. AR R5's static test allows apply code only under `sup/release/`. | **Resolved 2026-10-16:** WE §8.6 designs it and WE E13 → STA18 builds it, in `sup/release/owner-apply.mjs` on REL8's adapters, so AR R5's test holds. UI17 adds the screens. | The owner decided results are applied by pressing Apply, under Review only. |
| C5 | OW S2 and PC S6 both create `dash/projects.mjs` and `td/projects.test.mjs`. | UI3 creates both; UI13 extends them. | One owner per file. |
| C6 | OW S5 and WE E8 both create `td/work.test.mjs`. | UI6 owns it for the Work screen; UI14 uses `td/approve.test.mjs` (OW S10's name). | Same file name for two different screens. |
| C7 | OW S5 writes new wait sentences in `dash/supervisor.mjs`; SCH S8 makes status the source of wait reasons. | UI6 renders today's waits; UI11 then switches the Work view to the status `wait` field from RUN9. | One source of truth for why a step waits. |
| C8 | OW S7 and MR R6 both build a per-step cost view. | UI12 extends UI8's Cost screen. There is one cost view. | No duplicate screen. |
| C9 | WE E11 is "no decision to build", but depends on PC S7, which used to wait for governance to merge the D2 schema (#24). | The schema now ships with AIWorks (#24 answered 2026-10-16), so STA15 waits for no one. STA16 still follows STA15. | The dependency is real: local admission validates rules from the overlay. |
| C10 | WE E2 puts `release.mode` in each campaign's envelope; AR §3 says the mode is per project and destination, never per campaign, and approving a campaign never turns Auto Release on. | STA7 accepts only `review-only`, which both allow. What the envelope field means after #33 is gap G6. | Until #33 the two agree in behaviour. |
| C11 | OW says S2 to S8 may run in parallel after S1. All of them change `pub/dashboard.js`. | Lane UI runs them in order. | No two slices may change one file at once. |
| C12 | PC S4 changes `sup/project-connect.mjs`, which PC S3 creates, but lists only S1 and S2 as dependencies. | STA4 follows STA3. | The file must exist first. |
| C13 | The previous section 6 put multiple workers in wave 4, after the workspace. | RUN goes first. | #14 asks for the operational fixes and the one-slot limit first, because they speed up everything after. |

### 6.13 Gaps

- **G1.** #27 has a fix direction but no design slice. RUN1 is built from #27's text (tests included) and links it. If the verifier judges that too thin, a short design note precedes RUN1.
- **G2.** Answered 2026-10-16: the Review-only local Apply is WE §8.6 and slice STA18 (C4).
- **G3.** "Changes requested" in Results needs GitHub's review state, which the dashboard no longer reads and the supervisor does not store. No design supplies it.
- **G4.** Answered: the coordinator's plans and answers stay in the local dashboard ([AW-004](DECISIONS.md#aw-004---the-coordinator-is-read-only), observed), so a plan for a project without GitHub needs no GitHub place. UI17 no longer waits for it.
- **G5.** Owner questions with no issue yet: SCH Q2 and Q3 (live scheduler, host ceiling; RUN10), MR Q1 and Q2 (models per account, live routing; MOD7). Under [AGENTS.md](../AGENTS.md#owner-intervention) each becomes one `owner-reserved` issue when its slice is reached, with today's behaviour as the default. SCH Q1 ships with its default. OW Q3 (Telegram) is answered "not in this program" by the design.
- **G6.** Answered 2026-10-17: the envelope's `release.mode` stays and accepts only `review-only`. A release mode belongs to a destination and comes only from a grant (AR §3), so the field is shown, never acted on (C10).
- **G7.** The one governance-side change left is the release schema for REL10, proposed as text in AR §10.2 and made by the governance contract's own process, never from here. D2 needs none: its overlay schema ships with AIWorks (PC §7.3, #24 answered 2026-10-16).
- **G8.** workstation state is unknown here. Whether R1-REST-PUBLISH, LD1-LOCAL-DATA or F1-AW005 is deployed has not been checked.
- **G9.** Designed 2026-10-16: the owner's decisions (e) AIWorks's own code trusts **local main**, with GitHub as an optional backup, and (f) AIWorks's own issues move to a **local work list**, with the open GitHub issues imported once, are [LOCAL_OPERATION](design/LOCAL_OPERATION.md) and lane SELF (6.8b). AW-005 and the provenance check name `origin/main` today; the amended text lands with SELF12. Nothing is built (planned).

### 6.14 Implementation boundaries (kept)

- `src/supervisor/`: durable admission, coordination and concurrency. #5's owner (F2-DUPLICATE) goes first on `api.mjs`, `campaign.mjs` and `store.mjs` (see 6.9).
- `src/dashboard/`: lane UI only. Keep the security headers, origin and CSRF checks, the 127.0.0.1 binding (AW-003), and never serve raw prompts, secrets or paths beyond the owner's own project root.
- `campaigns/`: initial approved private approved declarations (AW-005). No local admission ledger or child amendment runs before STA17 is built, reviewed and deployed.
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

**Owner decisions of 2026-10-16 (#24, #32, #14).** The owner said: "This AIworks should work with no dependency on Github." They chose:

- **(a) Scope:** the projects AIWorks works on, and AIWorks itself.
- **(b) Project rules (D2, #24 option 1):** the owner confirms a project's rules once in the dashboard, valid for up to 12 months. The overlay schema ships with AIWorks, so the governance contract is not changed ([PC §7](design/PROJECT_CONNECTION.md#7-decision-d2-the-rules-a-project-without-github-follows); slices STA15, UI16).
- **(c) Starting work (D4, #32):** approving a plan in the local dashboard admits exactly that plan, bound to its digest, with no signing key ([WE §8](design/WORK_ENVELOPE.md#8-decision-d4-local-admission-without-github); slices STA16, STA17, UI14, UI17).
- **(d) Results:** reviewed in the dashboard, then applied when the owner presses Apply, after a rescan that refuses changed files, with a backup and Undo apply. An owner action under Review only, not Auto Release ([WE §8.6](design/WORK_ENVELOPE.md#86-results-review-then-apply); slices REL8, STA18, UI17).
- **(e) AIWorks's own code:** local main is the trusted source; GitHub is an optional mirror ([LO §4](design/LOCAL_OPERATION.md#4-local-main-is-the-trusted-source); slices SELF2 to SELF4, SELF8, SELF9, SELF12, SELF13, UI19).
- **(f) AIWorks's own issues:** a local work list, with the open GitHub issues imported once ([LO §5](design/LOCAL_OPERATION.md#5-the-local-work-list); slices SELF5 to SELF7, SELF10, SELF11, UI20).
- **(g) Order:** campaign `aw-ui-fix-5` runs first.

**Owner decisions of 2026-10-17 (#33, cleanup).** The owner answered #33 item 1 "yes". On item 2 they said: "do it easier. I don't want to watch after tokens now", and left the rest to be decided from these documents. Decided:

- **(h) The release decision (#33 item 1):** accepted. REL9 records [AR §10.1](design/AUTO_RELEASE.md#101-proposed-aiworks-decision-aw-008) under the next free number (AW-010 at this revision: AW-008 and AW-009 are taken, C2), with decisions (i) to (m).
- **(i) The release identity (#33 item 2):** no release token. A release uses the logins already on this computer: the operator's `gh` login for a merge, as the merge gate does today, and the project's own `deploy`, `observe`, `check` and `rollback` commands with the access they already have. Nothing is created, stored or renewed. The grant, checked in code before every step, limits a release to its repository and destination; the credential no longer does ([AR §6](design/AUTO_RELEASE.md#6-the-release-role), slice REL5a). Grants still expire after at most 90 days, and an expired grant only returns the destination to Review only.
- **(j) The first canary (#33 item 3):** the disposable rehearsal of REL11 first. Then one grant for one owner project's production destination, `docs` and `tests` changes only, for 30 days; `app-code` only through a newer grant after those releases ran cleanly. The merge-only canary on AIWorks's `main` (AR §12 Q3) is dropped: since #138 the merge gate already merges every verified AIWorks campaign PR, so it would test nothing new, and AIWorks never releases into its own live runtime.
- **(k) One merge path per repository:** in a repository the merge gate covers, only the merge gate merges. A release there deploys the merge commit the gate recorded, after the tree check of AR §7.2 step 3, and never makes a merge call of its own (destination kind `deploy`). A GitHub project whose own rules let an agent merge a verified, conflict-free PR may be listed in `merges.repositories`; that list stays private configuration. The release merge adapter (REL6) is built only for a project that wants releases without the merge gate.
- **(l) Cleanup after finished work:** AIWorks removes the worktrees of finished tasks and deletes the local task branches that the trusted main already contains. It never deletes a remote branch, a worktree with uncommitted files, or run evidence. Nothing is cleaned before lane CLN is built; CLN2 records a baseline before it switches cleanup on and compares after (section 6.8c). REL9 amends the AW-001 sentence "never ... removes worktrees or deletes branches" to match.
- **(m) AIWorks's own live runtime:** upgrades stay manual, through the upgrade procedure (AR §12).
- **(n) AIWorks starts the next wave by itself (#153 option B).** The owner said: "stop asking me questions. just do it." The owner approves one private, digest-bound program record once. It names this plan, the slices allowed and the slices excluded, the executor chain and the constraints. AIWorks then builds each next wave's declaration from section 6 by fixed rules, not by a model, and registers it only when every slice fits the record exactly. Anything that does not fit becomes one Needs me item. Runbook-only slices, which change the live install, are never proposed. Lane PROG (section 6.8d) builds it switched off; PROG4 records the decision; PROG5 switches it on.

These are recorded design decisions. None of them is built or deployed by this plan (planned).

| ID | Detailed design/authority question | Resolution (decided, or proposed pending review) | Dependency |
| --- | --- | --- | --- |
| **D2** | How does a **local-only project** inherit governance without per-folder GitHub PRs? | **Decided 2026-10-16 (b).** An owner-confirmed local overlay entry, validated by a schema that ships with AIWorks; it can only add or tighten rules and inherits every portfolio policy from the governance directory. No governance change. | STA15, UI16 |
| **D4** | How can fully local projects authorize campaigns and produce new child tasks while AW-005 requires an AIWorks main declaration? | **Decided 2026-10-16 (c).** Trusted, reviewed, pinned code stays required. The owner's approval in the local dashboard admits exactly that plan, bound to its digest, with no signing key; a caller check refuses approvals from AIWorks's own processes; an append-only ledger records approvals and child amendments, bounded by the approved envelope. The GitHub path stays available. STA17 records the decision. | STA16, STA17, UI17; #5, #8 |
| **D5-gate** | Exactly which releases can **Auto Release** perform, and to which destinations? | **Decided 2026-10-17 (h) to (k).** Default OFF. A standing grant per project, destination and change class, expiring within 90 days, with an independent exact-revision verifier and eligibility, rollback and health gates; no release token (i); one merge path per repository (k). AW-001 is amended by REL9; nothing runs before REL11. | REL5a, REL7, REL9 to REL11; governance review (REL10) |
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
