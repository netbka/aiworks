# AIWorks - Project-first owner workspace and adaptive delivery plan

**Status:** PLANNING ONLY. Owner approved four product-direction decisions on 2026-10-12 (recorded in section 8). These are design requirements, **not** authorization to change the running supervisor, merge/deploy, add credentials or override AW-001..AW-007. Execution/release permissions remain governed by the applicable, separately reviewed authorization gates.

**Prepared:** 2026-10-12. Repository basis: `netbka/aiworks` main at `c63333cc04581e469d7fed4840f470db8dda7a09`, and the linked `netbka/engineering-platform` main. Every "current" statement below describes inspected repository code/docs as of this revision; it is not a new live-host check.

**Tracking:** This planning PR plus [Workspace #7](https://github.com/netbka/aiworks/issues/7), [#8](https://github.com/netbka/aiworks/issues/8), [#9](https://github.com/netbka/aiworks/issues/9), [#10](https://github.com/netbka/aiworks/issues/10), [#11](https://github.com/netbka/aiworks/issues/11), and [#13](https://github.com/netbka/aiworks/issues/13) (opt-in automatic release); existing [#1](https://github.com/netbka/aiworks/issues/1)..[#6](https://github.com/netbka/aiworks/issues/6). This is the one implementation-roadmap document for this redesign. GitHub issues/PRs remain the live work-state authority.

## 1. Product, stated from the owner's job

**One sentence:** AIWorks runs and supervises AI-assisted delivery across the owner's local projects - with or without GitHub and even when the starting folder has no Git metadata. Connect a folder, specify an outcome or existing work, approve one scoped work program, then let AIWorks plan, dispatch, independently check, adapt and continue. An optional separately authorized release mode can complete a project's delivery when its verified release gates permit it.

**The job:** "I develop several applications. I want to connect each project, tell the system what to work on, let it choose a reasonable number and tier of agents, and see what has been delivered, what is running and what I must decide - without babysitting terminals or reading an engineering control panel."

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
| Configured local Git checkouts and isolated worktrees (`README.md`, `src/supervisor/adapters/git.mjs`) | Paths/repos are manually registered in local `config.json`; no folder-first onboarding. GitHub remote and EP GitHub-repository match are currently required for campaign admission. Fully local/no-Git support needs a new scoped local project contract and adapter. |
| Coordinator with durable owner-message receipts and read-only research (`src/supervisor/coordinator.mjs`) | It proposes work but does not turn an approved plan into a registered execution program. |
| Task DAG, declarative executor chain, project governance lookup (`src/supervisor/campaign.mjs`, `controller.mjs`) | `limits.slots` permits only `1`; `schedule()` exits when one operation is open. No adaptive parallelism or fair cross-project capacity controller. |
| Explicit Claude/Codex/Cursor models, AGY/browser adapter, independent verifier, provider fallback and some cost receipts | Provider order/model choices are declared per campaign, not quality/cost-selected per task/role. Some costs remain unreported; account cooldown scope across campaigns is a risk (#5). |
| Dashboard with owner-attention reconciliation, GitHub issue/PR metadata, commands, receipts and activity (`src/dashboard/`) | Global sections are Overview / Plans / Issues & PRs / Agents / Messages / Activity; Overview mixes every concern. A project is not the main navigation context. |
| EP inherited governance and AIWorks-local `AGENTS.md`, decisions and constitution | Inheritance is already correct; **do not fork EP policies or duplicate generic documentation here**. |

Current GitHub snapshot: zero open PRs and six pre-existing open issues when this planning work began (#1..#6). Archived `engineering-platform-archive` PRs [#126](https://github.com/netbka/engineering-platform-archive/pull/126) and [#139](https://github.com/netbka/engineering-platform-archive/pull/139) are **closed and unmerged**; issue [#6](https://github.com/netbka/aiworks/issues/6) tracks their selective port. The current branch's planning-only PR should not race with those runtime files or with the previously reserved audit-fix work in #5.

### Existing authority and constraints (non-negotiable for this plan)

- [AIWorks AGENTS.md](../AGENTS.md), [Product Constitution](PRODUCT_CONSTITUTION.md), [Decisions AW-001..AW-007](DECISIONS.md), [Supervisor](SUPERVISOR.md), [Worker Context Lifecycle](WORKER_CONTEXT_LIFECYCLE.md).
- [EP Constitution](https://github.com/netbka/engineering-platform/blob/main/docs/CONSTITUTION.md), [Agent Operating Model](https://github.com/netbka/engineering-platform/blob/main/docs/AGENT_OPERATING_MODEL.md), [Continuation](https://github.com/netbka/engineering-platform/blob/main/docs/CONTINUATION.md), [Owner Intervention](https://github.com/netbka/engineering-platform/blob/main/docs/OWNER_INTERVENTION.md), [Governance Inheritance](https://github.com/netbka/engineering-platform/blob/main/docs/GOVERNANCE_INHERITANCE.md), [AGENT-001](https://github.com/netbka/engineering-platform/blob/main/policies/AGENT-001.json), [Delivery Practices](https://github.com/netbka/engineering-platform/blob/main/docs/DELIVERY_PRACTICES.md), [Experience Review / UX-002](https://github.com/netbka/engineering-platform/blob/main/docs/EXPERIENCE_REVIEW.md), [Behavioral Interaction / UX-001](https://github.com/netbka/engineering-platform/blob/main/docs/BEHAVIORAL_INTERACTION.md).
- EP owns portfolio policies, project registry, role catalog and project-contract schemas. AIWorks reads the governance checkout, never writes it as a side effect of project selection. `registry/projects/aiworks.json` already registers AIWorks with `ui` and `worker` capabilities. **Gap:** the existing GitHub-identified registry/target contract cannot express an ordinary folder without a remote. Support requires a reviewed EP-compatible local project identity/contract and explicit project governance inheritance, not skipping governance checks.
- AW-001 currently prohibits supervisor merges, deployments and provider-resource mutations. The owner now wants a **separate, opt-in Auto Release mode** (#13), but this new direction does **not** amend AW-001 or itself grant runtime deployment rights. A narrowly reviewed AW decision, scoped release capability and required EP release authorization must precede enablement. AW-003: local-only dashboard; AW-006: no combined dashboard across machines. "Several projects" means several local projects on this machine.
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

**Governance gap:** Today project admission depends on an EP registry entry keyed by GitHub repository. Before local-only dispatch, review and extend EP's project-identity/registration contract to authorize a local project by stable owner-scoped ID and approved local authority pointers. AIWorks must consume that contract from the read-only governance checkout (or another formally approved read-only inherited-governance mechanism); do not bypass policies because a remote does not exist.

A local connection references:
- stable owner-scoped project ID, source kind, canonical local root, selected source revision/snapshot, isolated worktree or managed mirror root, machine identity and optional GitHub identity/base branch;
- verified capability flags and status (Not connected / Needs setup / Ready / Temporarily unavailable), governance binding, last preflight and precise recovery action;
- no credentials or secret values. Paths may be displayed **only** inside this owner's local-only UI subject to existing containment; no untrusted worker output or public exposure.

**Connection flow:** Pick directory -> inspect Git if present -> choose `GitHub` / `Local Git` / `Local folder` -> verify source and permissions -> establish approved local governance identity -> configure isolated working state -> save -> open project. Do not require a remote, `gh` login or Internet access **for project connection itself**. Online AI CLIs may still need their own provider connectivity; local project support is **not** a claim that all models run offline.

**Local-folder write contract:** Use a revisioned snapshot or internal managed Git mirror as the agent's source-of-truth staging surface, not an uncontrolled writable copy of the original. Bind a baseline hash/manifest before task dispatch; agents only mutate isolated staged workspaces. Before applying results to the owner's source, check for changes/conflicts, owner-selected output policy and reversibility; preserve original files/backups, refuse unresolved overlaps and record a verifiable local result. Symlinks, junctions, nested repositories, file permissions, case-folding on Windows, ignored/secret-like paths, oversized projects, binary changes, deletes and external file mutation must have explicit preflight and tests. No automatic whole-folder recursive command or secret copying.

Connection does not itself authorize execution or release. Require tests across GitHub, local Git and non-Git sources with two concurrent projects. Keep EP's role, policy, ownership and evidence constraints for all three modes.


### 3.2 Work request - one authorization, autonomous execution inside its scope (owner approved D3)

Required: project identity/source kind, request type (`goal`, `issue`, `pr`, `plan`, or `local task`), human outcome, optional issue/PR reference when GitHub exists, pinned initial revision, acceptance intent, authorized write/release boundaries and explicit scope version. Existing issue/PR selection is **optional**; a local folder can start directly from a goal or a local task/plan file.

**Plan only:** read-only planning/report, without changing the owner's files.

**Plan and execute:** coordinator researches and proposes a bounded, independently checkable plan. The owner approves the **outcome envelope once**; AIWorks then chooses, creates, revises, routes and executes internal tasks and repairs **without asking again for each task**. The Task Controller remains accountable for the entire outcome.

The initial campaign declaration and supervisor code still need AW-005's merged-main gate. Plan an explicit **versioned autonomous task-graph amendment** inside the already approved authorization envelope, with a durable audit/decision record, admission checks and existing fencing, rather than a new owner approval/PR for each micro-task. No change can widen project files, capabilities, permissions, destination, cost cap (when set), release mode or acceptance goal. Any such scope change pauses only the affected work and asks for new owner authority.

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

The **initial** main-only campaign declaration remains immutable under AW-005 unless an explicitly reviewed internal versioned-amendment mechanism preserves its approved scope and provenance. Ordinary in-scope decomposition/repair must not repeatedly interrupt the owner. Invalid or uncertain local file application is never silently replayed after a crash; reconcile the actual target.

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

Keep a maximum of one obvious primary button per state; do not show inactive technical buttons as decoration. Empty, disconnected, no-worker, GitHub-stale, paused, running, blocked and finished states each require explicit truthful copy. Preserve selected project, route, scroll and unsent draft after refresh/back. Navigation shows a short project name rather than campaign IDs; link actual GitHub artifacts when a remote exists and verified local artifacts otherwise. Add a project-scoped `Release mode` entry (Review only / Auto Release), where Auto Release stays unavailable until separately authorized (#13). Existing `Needs you` correctness, lifecycle evidence and receipts in [#4](https://github.com/netbka/aiworks/issues/4) are **reused**, not thrown away.

**Language (owner approved D9):** The UI is **English only for this release**. Keep all labels, errors, actions and empty states in natural, short English; do not allocate a localization framework or Russian copy work. Use normal human outcomes and short verbs. Avoid "pipeline", "fencing", "lease", "slots", "project control plane" or "campaign declaration" at the primary UI level. Technical terms belong in diagnostics. Current interface is English; adding Russian/localization is an open scope choice, not an implied blocker. UX-001/UX-002 reviews apply to the actual interactive local dashboard; start with a blind task-oriented review before approving visual polish.

**Responsive:** 320px first, tablet and desktop; full keyboard navigation, explicit status, focus, screen reader labels, no overflowing status matrices. Do not solve structural problems by adding explanatory paragraphs.

## 5. Execution design - build on the current supervisor


### 5.1 Planning and task breakdown - autonomous inside one approval

- The read-only coordinator reads relevant project authority, local files, known campaigns and, only when configured, GitHub issue/PR metadata. A local project must not fail simply because `gh` is missing.
- One accountable Task Controller owns the whole approved outcome. Build the smallest useful dependency graph, with real acceptance criteria. Split only when it adds useful independent work.
- After one owner approval of the **outcome + scope + permissions + project + optional spending caps + release mode**, the controller may add or revise internal child tasks/repair work **inside that envelope**, with a durable versioned plan and verified admission against unchanged boundaries. Do not ask for each child step.
- No accidental backlog claiming, duplicate fixes, role-generated scope expansion, new project, credential exposure or permission grant. If scope needs to expand, seek a separately recorded decision.
- Existing supervisor `campaign.mjs` treats tasks/declaration as immutable; implementation needs a reviewed schema/lease-safe amendment design reusing current SQLite, controller, packet digest, AW-005 and process ownership. New child-plan versions must be bound to actual merged runtime/code and approved envelope. New task admission must be idempotent after crash/retry.
- An independent verifier remains separate from the implementer. For a local folder use managed staging and local evidence; no GitHub URL is required to prove local work.
- Once registered, continue automatically on independent completion, review finding, provider reset and bounded recovery; route only genuine owner-reserved blockers to the owner.

### 5.2 Adaptive parallelism

Current code: `campaign.mjs` rejects `limits.slots != 1`; `controller.mjs.schedule()` returns when a campaign has an open operation. The proposed work must change admission, not blindly launch processes.

**Runnable capacity** is bounded by independently ready DAG nodes, write-domain/work-key ownership, verified worktree isolation, relevant provider/account availability, process/CPU/memory health, active verifier needs, host safety and explicit owner controls.

**Scheduler behavior:** Start with conservative admission, measure useful completions and resource pressure, increase fanout only when independent work makes that valuable, reduce it on thrash, retry storms or real saturation. Allocate opportunities fairly across projects, and avoid two concurrent writers for the same logical repair (including separate campaigns). Provider cooldowns must not be isolated per campaign if the same actual account is exhausted. A full slot does not mean "agent failed": show the wait reason and next expected automatic action.

Keep the existing SQLite work authority, revision-pinned task packets, lease generations, process containment and idempotent external effects. No parallel implementation/verifier work on the *same* material deliverable without the existing verification sequencing and independence. A controller crash cannot let another project unknowingly duplicate a partially applied write.

**Acceptance gates:** serial-vs-parallel outcome comparison, independent tasks really overlap, conflicts never do; two projects make progress without starvation; crash/restart/timeout/unknown-acceptance and quota recovery do not duplicate an external write. Evidence comes from synthetic/focused tests before HomePc rehearsal.

### 5.3 Role/model/cost routing

Use the role catalog already in EP: orchestrator, product/system architect, UX, frontend, backend, DB, security, independent verifier, product reviewer, release and observer. Do **not** duplicate this catalog. Assign a role only when it has a real independent decision, work product or acceptance obligation.

Provider eligibility is determined from **this host's** configured authorized CLIs, permissions, project constraints, role capability and real observed errors. Provider/model *cost and reliability* are attributes of a task stage, not a reason to weaken verification. Proposed decision pipeline:

1. Determine deterministic role/risk/complexity indicators from the approved task and changed boundaries.
2. Filter models/providers by current account authorization, native role/tool support, host support, provider availability and independent-verifier eligibility.
3. Pick the lowest expected *total accepted-outcome cost* for that class (implementation + planning + verification + retries + expected rework), balancing speed and failure risk. Cheap first is not a rule if it causes expensive repeated repairs.
4. Elevate model tier on evidence of insufficient quality or repeated failure; do not escalate for permission denials or leaked/unknown credits.
5. Preserve the chosen executable/model and reason in a versioned receipt so replay/diagnostics are unambiguous. An owner pin overrides ranking within safe permissions.
6. Keep unreported pricing/usage as **unknown**. A subscription-based or provider-limited CLI may not expose a reliable marginal dollar cost; report native units and comparable observed workload without fictional savings.

No idle LLM heartbeat, no provider account rotations outside granted accounts, no default monetary/run caps (AW-002), no new autonomous recurring spend under EP's portfolio rules. Measure baseline and run a small cohort before claiming optimized token or dollar savings.

### 5.4 Owner intervention and results

Reuse [#1](https://github.com/netbka/aiworks/issues/1) for blocker dedup/Telegram recovery, [#4](https://github.com/netbka/aiworks/issues/4) for owner-attention evidence, and [#5](https://github.com/netbka/aiworks/issues/5) for duplicate prevention and parent-outcome closure. Do not build another notifications database, parent state machine or separate watchdog LLM. Persistent warnings must route to the same owner queue whether seen locally or through the approved Telegram transport.


### 5.5 Separate Auto Release mode (owner approved D5; tracked #13)

**Product direction approved:** AIWorks will include **two per-project release modes**:

- **Review only** - default, current behavior. AIWorks stops after a verified publish/candidate and gives a truthful next action. It never merges, deploys or applies staged changes automatically.
- **Auto Release** - explicitly enabled **per project and destination/environment** after its own versioned release authorization and necessary independent validation. It may progress a verified candidate through release and post-release checks without asking again for each routine eligible deployment **only within the standing grant**.

**Critical authority boundary:** Existing AW-001 prohibits supervisor merge/deploy. The user's approval of this *feature* does not grant production rights to the current supervisor. Before runtime enablement, create a narrowly scoped AW decision/constitution amendment and align the target project's EP contract/release policies, independently review the actual release adapter and perform a disposable rehearsal. Do not grant implementer/verifier agents deployment credentials; release is a separate scoped role/capability with dedicated local authorization and kill switch.

**Eligibility:** immutable candidate artifact/revision; independent verification of the exact revision; required tests/security/UX evidence for that target; authorized destination and permitted change class; no stale dependency or changed head; appropriate migration/rollback readiness; no new recurring spend or elevated permissions; exclusive destination lock and durable idempotent deployment state. Missing/unknown evidence blocks release. Irreversible/destructive migrations and other EP owner-reserved triggers must stop and request owner approval.

**GitHub vs local:** When a GitHub project has a permitted merge gate, Auto Release can use that approved gate and then deploy. A GitHub-less local project has **no PR merge step**: its authorized release adapter checks the original source baseline, applies/publishes an exact reviewed revision to a configured local target with reversible backup, verifies the actual result and records it locally. Never silently copy changes over concurrent owner edits or deploy to arbitrary folders.

**Post-release:** validate health/journey evidence, record target revision and outcome, offer a real pause/revoke/rollback action, alert for failure through #1. A restart reconciles unknown acceptance, rather than repeating a potentially irreversible action. Distinguish merged, applied, deployed and end-user accepted status - including unknown.

**Delivery waves:** govern/authorize release capability -> eligibility evaluator and compact project UI -> local/GitHub release adapters -> independent safety and rollback tests -> explicitly authorized canary. Implementation belongs to [#13](https://github.com/netbka/aiworks/issues/13), not this planning PR. No real release is currently authorized.

## 6. Delivery sequence, dependencies and file ownership

| Wave | Work package | Source/issues | Exit evidence and blocker |
| --- | --- | --- | --- |
| **0 - settle authority and correctness** | Review product journey in this PR; measure baseline; selective port of archived #139 (AW-005 main-only) and #126 duplicate admission; reconcile coordinator/dashboard evidence and governance pointers. No competing repairs. | #2, #4, #5, #6 | Focused regression/independent review. If AW-005 or duplicate ownership remains unimplemented, **no one-click execution**. |
| **1 - project connection** | Connect GitHub repo, local Git or plain folder; revisioned managed mirror for non-Git; guided EP local identity contract. | #7 | GitHub and GitHub-less examples, including non-Git folder, independently isolated; no mutation on connect. |
| **2 - define/start work** | Goal/issue/PR/local-plan intake, one owner-approved envelope, main-only campaign creation and versioned in-scope task amendments. | #8, #3, #2 | New children/repairs continue without per-task approval; no scope expansion or unauthorized dispatch. |
| **3 - owner workspace** | Replace global technical layout with project selector, project status/work/results, Needs me, detail views and compact meaningful wording. | #11, #4, #6 | Independent blind journey review, behavioral review and responsive keyboard/mobile acceptance. |
| **4 - multiple useful workers** | Scheduler admission/fairness/resource safety with cross-campaign work ownership and shared-provider cooldown. | #9, #5, #2 | Two independent tasks and two projects concurrently execute; race and failure cases pass. |
| **5 - model economics** | Capability/role routing, recorded provider costs/unknown values, post-verification efficiency measurement and escalation. | #10, #5 | Cost/quality baseline and before/after evidence, no misleading claimed savings. |
| **6 - opt-in release capability** | Separate Auto Release mode OFF by default; target-scoped release authorization, audited eligible merge/apply/deploy, rollback and post-release evidence. | #13, #2, #7, #8 | No release without separate grant; local and GitHub targets verified; restart and failure safe. |
| **7 - hardening and acceptance** | Telegram actionable intervention, crash recovery, live runtime/upgrade rehearsal, security/UX review including local-only and auto-release states. | #1, #2, #4, #6, #13 | Independent exact-revision review, upgrade/rollback readiness, project-specific authorization and outcome evidence. |

Waves are **dependency-oriented**, not a mandate to have five idle agents or force all code into one PR. Split each into reviewable vertical slices (data/API/UX with end-to-end evidence), assigning one owner for each source file and parent outcome. UX wireflows and blind review happen before implementing visually heavy UI. Keep checks narrow during iteration; run the canonical repository check for merge readiness.

### Explicit implementation boundaries

- `src/supervisor/`: durable campaign/admission, coordination and concurrency. The existing audit-fix owner on #5 has priority over overlapping edits to `api.mjs`/`campaign.mjs`.
- `src/dashboard/`: new local UI/interaction and presentation adapters; preserve security headers, origin checks and CSRF, and never serve raw prompts/secrets/paths.
- `campaigns/`: initial approved declarations committed on main; versioned in-scope task-plan amendments stay bound to that approved authority and need a separately reviewed schema/contract before use.
- `docs/`: AIWorks-specific product flow, decisions and operations. EP portfolio standards only linked, not copied. Separate narrowly scoped AW release decision and EP project/identity contract changes must be reviewed outside this planning PR before local-only execution and Auto Release are activated.
- `tests/`: new synthetic first-run/GitHub-less managed-mirror/multi-project/autonomous-child-plan/parallelism/model-router/release-rollback/unknown-state/UX review evidence; never use real customer data.

**Stop before implementation** where an owner-reserved question in section 8 changes authorization or product boundary; independent tasks without that dependency may be designed and tested. This planning PR itself should remain draft and contain documentation only.

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

Acceptance must use source-appropriate evidence: L0 plan, L1 interactive UI review, L2 contract tests, L3 integration, L4 HomePc runtime check and further target-project/client evidence only where the particular claim requires it. Unknown is not green. All supervisor-code changes need independent approval of the exact commit, and live checkout changes require the documented pinned-upgrade sequence.


## 8. Owner decisions and remaining implementation-design gates

**Owner acceptance recorded 2026-10-12 in the AIWorks conversation (PR #12):**

- **D1 - APPROVED:** Fully local projects are supported. GitHub is optional, including support for a folder with no remote and no Git metadata. Do not claim offline LLM availability. See #7.
- **D3 - APPROVED:** After one authorization of the requested outcome and boundaries, the system autonomously plans, splits, assigns, retries, reviews and closes **internal tasks** without separate approvals for each child. A new outcome/permission/release authorization is not covered. See #8 and #9.
- **D5 - APPROVED PRODUCT DIRECTION:** Provide a distinct **opt-in Auto Release** mode in addition to default manual review. This is **not** immediate authorization to merge/deploy; AW-001 and EP release gates remain effective until their separately reviewed narrow amendment/authorization. See #13 and section 5.5.
- **D9 - APPROVED:** The owner interface is **English**. No localization implementation is planned in this scope. See #11.

| ID | Still-open detailed design/authority question | Proposed resolution pending proper review | Dependency |
| --- | --- | --- | --- |
| **D2** | How does a **local-only project** inherit and register EP governance with no GitHub identity? | Extend EP project registry/contract for a stable owner-scoped local project identity and project authority pointers, with a reviewable local-only project contract. AIWorks consumes this read-only. Do not silently bypass the current registration check. | EP scoped contract PR + #7 |
| **D4** | How can a one-time approved outcome produce new executable child tasks while **AW-005** requires declarations and runtime on main? | Initial campaign declaration is merged and pinned; define a versioned append-only child-plan/amendment record, formally bounded by the originally approved scope, verified before admission and resistant to stale/replayed updates. Separate schema/policy compatibility review, no unmerged code. | #2, #5, #6, #8 |
| **D5-gate** | Exactly which releases can **Auto Release** perform, and to which destinations? | Default OFF. Separate owner-approved standing capability scoped to project/environment/change classes/target, independent exact-revision verifier, eligibility/rollback/health gates; narrowly amend AW-001 via a separate reviewed change. | #13 + EP release governance |
| **D6** | Cross-machine aggregation? | Keep the existing AW-006 single-machine dashboard. Multiple projects on the same machine do not require a second-PC view. No change requested. | none |
| **D7** | Worker count? | Adaptive Auto with an optional manual resource concurrency setting. Do not introduce default campaign run/cost ceilings under AW-002. | #9 |
| **D8** | Model choice? | Automatic capability-, role-, quality- and cost-aware routing across existing authorized providers, with optional model pin. Unknown billing stays unknown. | #10 |
| **D10** | Completion semantics? | Independently verified candidate, local apply/PR merge, release and observed outcome are separately evidenced. Auto Release can advance eligible states, not manufacture them. | #4, #8, #13 |

**No additional permission can be inferred from approving a product requirement.** Never silently rewrite EP portfolio rules, AW-001/AW-005, credential boundaries, independent verification or actual project release grants. The above table records design obligations, not reasons to ask the owner the same product questions again. The remaining decisions should be resolved by engineering/review under existing authority where possible; ask the owner only for a genuine owner-reserved release/permission change.

## 9. Planning-only PR acceptance

- [ ] Product purpose and project-first owner journey are understandable without knowledge of the supervisor, DAG or EP, for both local-only and GitHub-backed projects.
- [ ] Every primary screen answers exactly one real-world question, with an observable entry action and useful empty/blocked states.
- [ ] Work is divided among #7..#11, #13 and existing #1..#6, with explicit dependencies and without duplicate implementations.
- [ ] EP policies are linked, not copied, and the current main-only/external-write/local-only boundaries are preserved.
- [ ] Existing runtime evidence is correctly labeled as code/docs observation; no new deployment or UI walkthrough is claimed.
- [x] D1, D3, D5 (product direction), D9 received explicit owner decisions on 2026-10-12 and are recorded above.
- [ ] D2, D4 and the D5 implementation-specific authority changes are designed/reviewed before relevant new runtime powers are enabled.
- [ ] Implementation proceeds through small independently reviewable PRs, not by merging an entire code rewrite as one branch.

**Out of scope of this draft:** runtime file changes, production upgrade, agent dispatch, new account connections, provider secrets, EP registry writes, actual release/merge/deployment and budget increases. Auto Release and local-only execution are planned capabilities, not currently enabled permissions.
