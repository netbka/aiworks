# AIWorks - Project-first owner workspace and adaptive delivery plan

**Status:** PROPOSAL / PLANNING ONLY. This document is not an execution authorization, not a campaign declaration and not an amendment to AW-001..AW-007. Do not change runtime, merge or deploy on the authority of this plan.

**Prepared:** 2026-10-12. Repository basis: \`netbka/aiworks\` main at \`c63333cc04581e469d7fed4840f470db8dda7a09\`, and the linked \`netbka/engineering-platform\` main. Every "current" statement below describes inspected repository code/docs as of this revision; it is not a new live-host check.

**Tracking:** This planning PR plus [Workspace #7](https://github.com/netbka/aiworks/issues/7), [#8](https://github.com/netbka/aiworks/issues/8), [#9](https://github.com/netbka/aiworks/issues/9), [#10](https://github.com/netbka/aiworks/issues/10), [#11](https://github.com/netbka/aiworks/issues/11); existing [#1](https://github.com/netbka/aiworks/issues/1)..[#6](https://github.com/netbka/aiworks/issues/6). This is the one implementation-roadmap document for this redesign. GitHub issues/PRs remain the live work-state authority.

## 1. Product, stated from the owner's job

**One sentence:** AIWorks runs and supervises AI-assisted delivery for the owner's local Git projects: choose a project, name the outcome or existing work, authorize the scope once, and let the machine plan, dispatch, check and continue until a real decision or a project's release boundary is reached.

**The job:** "I develop several applications. I want to connect each project, tell the system what to work on, let it choose a reasonable number and tier of agents, and see what has been delivered, what is running and what I must decide - without babysitting terminals or reading an engineering control panel."

AIWorks is **not** a Git hosting provider, chat-first general assistant, portfolio governance registry, multi-user cloud SaaS, remote-access system, generic autonomous backlog claimer or a new release authority.

**Value hierarchy:**
1. *Start a useful outcome* from a local project and a human instruction, issue, PR or plan.
2. *Keep it moving* after explicit owner registration: planning, a dependency-aware task graph, eligible workers, separate checking, retry/recovery and trustworthy outcomes.
3. *Show the outcome* by project and request the owner's attention only when necessary.
4. *Optimize execution* for accepted results, independence, elapsed time and cost/usage - not for worker counts, token counts or an attractive dashboard.

A **project** is the primary product object. A **campaign** is one authorized work program within a project. A **task** is a deliverable in that program. An **agent** is a short-lived role execution, not an object the owner must manually administer.

**Acceptance definition:** The owner can connect two distinct repositories, launch a permitted work program for either, keep both visible, inspect truthful independent verification and GitHub merge state, and have the system continue without another "continue" prompt. It must never imply that "PR published" means "merged", "deployed" or "accepted".

## 2. Keep the existing machine - fix the owner-facing workflow

### Repository observations (do not reimplement)

| Present and useful | Limitation requiring work |
| --- | --- |
| Deterministic supervisor with SQLite operations, fencing, restart recovery, worker/verifier separation (\`src/supervisor/\`) | The owner must prepare \`campaigns/*.json\` and register through the CLI. There is no dashboard create-project/create-campaign route. |
| Configured local Git checkouts and isolated worktrees (\`README.md\`, \`src/supervisor/adapters/git.mjs\`) | Paths/repos are manually registered in local \`config.json\`; no folder-first onboarding. |
| Coordinator with durable owner-message receipts and read-only research (\`src/supervisor/coordinator.mjs\`) | It proposes work but does not turn an approved plan into a registered execution program. |
| Task DAG, declarative executor chain, project governance lookup (\`src/supervisor/campaign.mjs\`, \`controller.mjs\`) | \`limits.slots\` permits only \`1\`; \`schedule()\` exits when one operation is open. No adaptive parallelism or fair cross-project capacity controller. |
| Explicit Claude/Codex/Cursor models, AGY/browser adapter, independent verifier, provider fallback and some cost receipts | Provider order/model choices are declared per campaign, not quality/cost-selected per task/role. Some costs remain unreported; account cooldown scope across campaigns is a risk (#5). |
| Dashboard with owner-attention reconciliation, GitHub issue/PR metadata, commands, receipts and activity (\`src/dashboard/\`) | Global sections are Overview / Plans / Issues & PRs / Agents / Messages / Activity; Overview mixes every concern. A project is not the main navigation context. |
| EP inherited governance and AIWorks-local \`AGENTS.md\`, decisions and constitution | Inheritance is already correct; **do not fork EP policies or duplicate generic documentation here**. |

Current GitHub snapshot: zero open PRs and six pre-existing open issues when this planning work began (#1..#6). Archived \`engineering-platform-archive\` PRs [#126](https://github.com/netbka/engineering-platform-archive/pull/126) and [#139](https://github.com/netbka/engineering-platform-archive/pull/139) are **closed and unmerged**; issue [#6](https://github.com/netbka/aiworks/issues/6) tracks their selective port. The current branch's planning-only PR should not race with those runtime files or with the previously reserved audit-fix work in #5.

### Existing authority and constraints (non-negotiable for this plan)

- [AIWorks AGENTS.md](../AGENTS.md), [Product Constitution](PRODUCT_CONSTITUTION.md), [Decisions AW-001..AW-007](DECISIONS.md), [Supervisor](SUPERVISOR.md), [Worker Context Lifecycle](WORKER_CONTEXT_LIFECYCLE.md).
- [EP Constitution](https://github.com/netbka/engineering-platform/blob/main/docs/CONSTITUTION.md), [Agent Operating Model](https://github.com/netbka/engineering-platform/blob/main/docs/AGENT_OPERATING_MODEL.md), [Continuation](https://github.com/netbka/engineering-platform/blob/main/docs/CONTINUATION.md), [Owner Intervention](https://github.com/netbka/engineering-platform/blob/main/docs/OWNER_INTERVENTION.md), [Governance Inheritance](https://github.com/netbka/engineering-platform/blob/main/docs/GOVERNANCE_INHERITANCE.md), [AGENT-001](https://github.com/netbka/engineering-platform/blob/main/policies/AGENT-001.json), [Delivery Practices](https://github.com/netbka/engineering-platform/blob/main/docs/DELIVERY_PRACTICES.md), [Experience Review / UX-002](https://github.com/netbka/engineering-platform/blob/main/docs/EXPERIENCE_REVIEW.md), [Behavioral Interaction / UX-001](https://github.com/netbka/engineering-platform/blob/main/docs/BEHAVIORAL_INTERACTION.md).
- EP owns portfolio policies, project registry, role catalog and project-contract schemas. AIWorks reads the governance checkout, never writes it as a side effect of project selection. \`registry/projects/aiworks.json\` already registers AIWorks with \`ui\` and \`worker\` capabilities.
- AW-001: no automatic merge, deploy or provider-resource mutations from the existing supervisor grant. AW-003: local-only dashboard; AW-006: no combined dashboard across machines. "Several projects" means several registered checkouts **on this machine**.
- AW-002: no default run/cost ceilings. Safety limits for actual host/provider concurrency are not equivalent to a monetary/run cap. All user-declared budgets remain honored.
- AW-004: coordinator is read-only. It must not independently register or dispatch work. AW-005: campaign declarations are on AIWorks \`main\` and runtime code is merged. UI convenience cannot bypass either gate.
- One accountable Task Controller per parent outcome; fresh independent verifier; durable bounded packets; no idle model calls, credential copies, peer-to-peer orchestration or invented completion evidence.

## 3. Product vocabulary and state model

### 3.1 Project connection (new lightweight local metadata, not a new governance registry)

A local connection references:
- stable project ID resolved from EP registry, canonical \`owner/repository\`, local checkout root, selected base branch, dedicated worktree root, machine identity and observed Git revision;
- verified capability flags and status (Not connected / Needs setup / Ready / Temporarily unavailable);
- last preflight time and explicit error reason; no credential values.

Connection is not evidence of worker authorization, a clean checkout, an authenticated provider or a live campaign. Local path is never inferred from a GitHub URL or exposed on remote links. GitHub work state, AIWorks SQLite execution state and EP governance stay in their existing distinct authorities.

**Connection flow:** Pick directory -> inspect Git -> confirm remote/repository -> confirm EP registration and worker preflight -> Save connection -> open project. If EP registration is missing, guide the owner through an EP review/PR and refresh after merge; do not bypass the read-only checkout or auto-push. Make path choice and registry/remote mismatch recoverable without destructive Git operations. Prefer a native local folder chooser only when the runtime can securely provide it; otherwise an accessible local directory field with inspection. Do not suggest browser JS can access arbitrary file-system paths.

### 3.2 Work request (new owner-facing object/view over established campaign authority)

Required: project, origin type (\`goal\`, \`issue\`, \`pr\`, \`plan\`), owner outcome, origin URL/revision if any, current \`main\` reference, acceptance intent and execution boundary. Proposed by coordinator or deterministic import; explicitly approved before becoming an executable campaign.

A request can be **Plan only** (read-only analysis/report) or **Plan and execute**. The former must not mutate a target repo. A planning report can be accepted, revised or used to propose a new approved campaign. Existing issues and PRs are *evidence and context*, not implicit permission to take their entire backlog.

Proposed intake output for approval:
1. *What you'll get*: one-sentence outcome and how success will be proven.
2. *What will be done*: small meaningful steps with dependencies and deliverables.
3. *What is already in flight*: matching active campaigns/open PRs and duplication warnings.
4. *What is permitted*: target repo, branch/base, authorized worker capabilities, work scope, merge/release boundary and optional owner-specified ceilings.
5. *Next action*: Preview plan, Approve work, or Resolve setup. No raw JSON is required in normal UI.

For an existing PR, pin exact head, origin, ownership, integration and required independent checks. Do not overwrite a third-party PR branch. For an existing plan, reconcile completed/merged/live portions before proposing additional work.

### 3.3 Lifecycle (do not flatten evidence)

\`Draft plan -> Awaiting owner authorization -> Declaration PR / main gate -> Registered -> Queued -> Implementing -> Independently checking -> PR/report published -> Awaiting merge/release -> Verified downstream outcome\`.

A published report may close an authorized *report-only* campaign without downstream deployment. A code campaign must show GitHub state separately (open, changed, merged, closed-unmerged) and, where available from the target project, deploy and real acceptance separately. Never claim these later states without corresponding evidence. Paused, blocked-owner, blocked-environment, provider-wait, unknown and cancelled are distinct from completed.

Material scope changes become explicit versioned amendments/decisions; ordinary repair loops within the accepted scope should not require another approval. Current immutable task graph is a restriction that needs a designed compatibility path before any autonomous replanning.

## 4. Owner information architecture - one primary question per screen

**Global navigation:**
- **Projects:** "Which project shall I open / which project needs attention?" Project list with one status and one action each; prominent **Add project**. Initial empty state starts here.
- **Needs me:** "What actually requires my decision or action across the projects?" Group by project, one decision per row and a direct action link. Provider cooldown is not an owner task.
- **Settings:** "Which local computer, repository connections and worker accounts can AIWorks use?" Machine/CLI readiness and optional policies live here, not on project overview.

**Inside one selected project:**

| Screen / question | First thing visible | Principal action | Hidden under details / separate screen |
| --- | --- | --- | --- |
| **Project / Where are we now?** | One real-world goal, current outcome, one next action; active/waiting truth | **Start work** or **Open current work** | Worker run IDs, provider chains, cost counters |
| **Start work / What should be done?** | Goal input and **Use issue / PR / plan** alternatives; \`Plan only\` | **Review proposed plan** | JSON declaration, command syntax, framework selection |
| **Review / What will run under my authorization?** | Work outcome, steps, verification, boundaries and existing work conflicts | **Approve work** (or revise) | Full task DAG and per-role executor parameters |
| **Work / What is running, queued or waiting?** | Outcome-oriented steps in simple order, reasons for waits and next dependency | **Open a step**; pause/recheck when applicable | Per-worker sessions and technical journal |
| **Step / What is this agent actually doing?** | Task outcome, role, progress backed by native receipts, verification result | **Send guidance** or see PR/evidence | Logs, attempts, exact model/limits |
| **Results / What is delivered and what remains?** | Delivered steps, accepted commits and open PRs clearly distinct from merged/deployed | **Review result** / **Open PR** | Detailed check evidence |
| **Cost / What did the outcome cost?** | Actual reported project and accepted-outcome consumption, unknown separately | **Inspect breakdown** | Raw token/input/cache and provider receipts |

Keep a maximum of one obvious primary button per state; do not show inactive technical buttons as decoration. Empty, disconnected, no-worker, GitHub-stale, paused, running, blocked and finished states each require explicit truthful copy. Preserve selected project, route, scroll and unsent draft after refresh/back. Navigation shows a short project name rather than campaign IDs; link raw GitHub artifacts where valuable. Existing \`Needs you\` correctness, lifecycle evidence and receipts in [#4](https://github.com/netbka/aiworks/issues/4) are **reused**, not thrown away.

**Language:** Use normal human outcomes and short verbs. Avoid "pipeline", "fencing", "lease", "slots", "project control plane" or "campaign declaration" at the primary UI level. Technical terms belong in diagnostics. Current interface is English; adding Russian/localization is an open scope choice, not an implied blocker. UX-001/UX-002 reviews apply to the actual interactive local dashboard; start with a blind task-oriented review before approving visual polish.

**Responsive:** 320px first, tablet and desktop; full keyboard navigation, explicit status, focus, screen reader labels, no overflowing status matrices. Do not solve structural problems by adding explanatory paragraphs.

## 5. Execution design - build on the current supervisor

### 5.1 Planning and task breakdown

- The coordinator reads only scoped existing project files, accepted project authority, EP policies, issue/PR metadata and known campaigns.
- One Task Controller owns the requested parent outcome. Derive the smallest useful DAG; do not spawn unneeded specialists.
- Estimate dependencies, shared file/write boundaries, risky changes and independent verification needs before fanout.
- A PR, issue or task already owned by another active program triggers duplicate-work reconciliation (#5). Treat previous incomplete parent acceptance as outstanding work, not as a new duplicate repair.
- Create campaign declaration/review artifact in AIWorks, traceable to owner intent. **Do not execute from an unmerged branch** (AW-005). The design must provide clear "review/merge/ready to register" states and a deterministic trigger after the actual gate is satisfied.
- Continue verified in-scope repairs and recovered waits autonomously; ask about new product scope, rights, irreversible changes, recurrent payments or genuine owner-reserved decisions.

### 5.2 Adaptive parallelism

Current code: \`campaign.mjs\` rejects \`limits.slots != 1\`; \`controller.mjs.schedule()\` returns when a campaign has an open operation. The proposed work must change admission, not blindly launch processes.

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

## 6. Delivery sequence, dependencies and file ownership

| Wave | Work package | Source/issues | Exit evidence and blocker |
| --- | --- | --- | --- |
| **0 - settle authority and correctness** | Review product journey in this PR; measure baseline; selective port of archived #139 (AW-005 main-only) and #126 duplicate admission; reconcile coordinator/dashboard evidence and governance pointers. No competing repairs. | #2, #4, #5, #6 | Focused regression/independent review. If AW-005 or duplicate ownership remains unimplemented, **no one-click execution**. |
| **1 - project connection** | Project connection state and secure local Git/gh/preflight; two projects and clear empty states; guided EP registration. | #7 | Synthetic 2-repository workflow, no mutation on connect, stale/mismatched origins handled. |
| **2 - define/start work** | Goal/issue/PR/plan intake, read-only coordinator proposal, bounded authorization preview, declaration PR/main gate, actual register/start acknowledgement. | #8, #3, #2 | User can start from a single natural-language goal without writing JSON; no unauthorized dispatch. |
| **3 - owner workspace** | Replace global technical layout with project selector, project status/work/results, Needs me, detail views and compact meaningful wording. | #11, #4, #6 | Independent blind journey review, behavioral review and responsive keyboard/mobile acceptance. |
| **4 - multiple useful workers** | Scheduler admission/fairness/resource safety with cross-campaign work ownership and shared-provider cooldown. | #9, #5, #2 | Two independent tasks and two projects concurrently execute; race and failure cases pass. |
| **5 - model economics** | Capability/role routing, recorded provider costs/unknown values, post-verification efficiency measurement and escalation. | #10, #5 | Cost/quality baseline and before/after evidence, no misleading claimed savings. |
| **6 - hardening and release gates** | Telegram actionable intervention, acceptance/recovery, local runtime/upgrade rehearsal, security/UX review, release follow-up. | #1, #2, #4, #6 | Independent exact-SHA review, pinned runtime upgrade procedure, rollback readiness and explicit owner authorization. |

Waves are **dependency-oriented**, not a mandate to have five idle agents or force all code into one PR. Split each into reviewable vertical slices (data/API/UX with end-to-end evidence), assigning one owner for each source file and parent outcome. UX wireflows and blind review happen before implementing visually heavy UI. Keep checks narrow during iteration; run the canonical repository check for merge readiness.

### Explicit implementation boundaries

- \`src/supervisor/\`: durable campaign/admission, coordination and concurrency. The existing audit-fix owner on #5 has priority over overlapping edits to \`api.mjs\`/\`campaign.mjs\`.
- \`src/dashboard/\`: new local UI/interaction and presentation adapters; preserve security headers, origin checks and CSRF, and never serve raw prompts/secrets/paths.
- \`campaigns/\`: approved declarations, created from a reconciled proposal and allowed on main only.
- \`docs/\`: AIWorks-specific product flow, decisions and operations. EP portfolio standards only linked, not copied.
- \`tests/\`: new synthetic first-run/multi-project/plan/parallelism/model-router/unknown-state/UX review evidence; never use real customer data.

**Stop before implementation** where an owner-reserved question in section 8 changes authorization or product boundary; independent tasks without that dependency may be designed and tested. This planning PR itself should remain draft and contain documentation only.

## 7. Evidence and success metrics

Measure before optimizing; do not infer a baseline from counts on a dashboard. Existing product metrics remain:
- Hours per week authorized work is idle while genuinely waiting on an owner action.
- Number of owner interruptions per week and proportion with a justified owner-reserved cause.

Add operational diagnostics (not new product goals):
- Time and number of actions from opening a local UI to first **authorized active work**, including governance/PR gates.
- Number of concurrent independent *useful* tasks; accepted outcomes per elapsed hour; percent of unproductive reruns/overlapping repairs.
- For each project: tasks ready, running, waiting (with cause), PR published, merged, release unknown/deployed/accepted, last verified evidence time.
- Per accepted outcome: reported model usage and costs, unknown cost count, verification/retry overhead, total time and rejected attempts. Do not claim savings without comparable receipts.
- Owner's ability to answer the screen's primary question without opening a technical panel (blind UX test).

Acceptance must use source-appropriate evidence: L0 plan, L1 interactive UI review, L2 contract tests, L3 integration, L4 HomePc runtime check and further target-project/client evidence only where the particular claim requires it. Unknown is not green. All supervisor-code changes need independent approval of the exact commit, and live checkout changes require the documented pinned-upgrade sequence.

## 8. Owner decisions to record before affected implementation

The suggested **defaults** are for discussion, not silently adopted AW amendments.

| ID | Question | Recommended default | Why it matters |
| --- | --- | --- | --- |
| **D1** | Must a project already have a GitHub remote? | Yes, to start a code campaign. Permit a disconnected local folder only as a setup step; do not create/push a remote silently. | GitHub remains the source of code review/results and EP registry uses the remote identity. |
| **D2** | May AIWorks write project registration to Engineering Platform? | No. Initially guide the owner to a separately reviewed EP PR, then refresh read-only governance. Later automate only under a specifically approved narrow grant. | AW-001 is an exception only for registered target campaigns; EP is portfolio authority. |
| **D3** | Is one authorized campaign enough to allow adaptive splitting and internal repair work? | Yes, **only inside** a versioned, reviewed outcome/permissions envelope; a new goal, independent backlog claim or permission increase returns to approval. The immutability amendment path must be designed first. | Avoid repeated prompts without granting unrestricted project ownership. |
| **D4** | What should **Start work** do under AW-005? | Stage a declaration PR, require its merge and check merged runtime, then explicitly record owner registration/acknowledgement. Never start unmerged code. Design a single guided flow that honestly shows these gates. | User wants one simple action; the existing release/admission contract still controls execution. |
| **D5** | Should AIWorks independently merge/deploy successful work? | No for this roadmap; retain existing AW-001 and target-project release gate. Surface a concise Review result/merge action link. | Avoid accidentally broadening production privileges. |
| **D6** | Several projects on one machine or a combined view of multiple PCs? | Several projects **on this one machine**. No cross-machine aggregation (AW-006). | Separate PC states cannot be invented or combined without a new owner decision. |
| **D7** | Do you want to choose number of workers or the system to choose? | Adaptive **Auto** default with an optional bounded manual concurrency override; do not invent default run/cost ceilings (AW-002). | Makes execution useful under variable host capacity. |
| **D8** | How should models be chosen? | Auto by role/complexity/observed outcome quality, with optional model pin per campaign; use existing authenticated CLIs/accounts only. | Cost, quality, quota and independence are all material. |
| **D9** | What language should the owner UI use? | Retain understandable English initially; prepare extractable UI strings and Russian copy only if desired, instead of immediately building a localization system. | Current UI is English and scope is a single-owner local tool. |
| **D10** | When is a development outcome finished? | For AIWorks: independently verified and published, with merge/deploy/real-world acceptance shown separately and with unknown states explicit. | Publishing a PR is not the user's final outcome. |

If a requested owner choice conflicts with AW-001..AW-007, record a narrowly scoped new AW decision and update the product constitution in a **separate reviewed change**; do not reinterpret existing decisions inside a planning PR.

## 9. Planning-only PR acceptance

- [ ] Product purpose and project-first owner journey are understandable without knowledge of the supervisor, DAG or EP.
- [ ] Every primary screen answers exactly one real-world question, with an observable entry action and useful empty/blocked states.
- [ ] Work is divided among #7..#11 and the existing #1..#6, with explicit dependencies and without duplicate implementations.
- [ ] EP policies are linked, not copied, and the current main-only/external-write/local-only boundaries are preserved.
- [ ] Existing runtime evidence is correctly labeled as code/docs observation; no new deployment or UI walkthrough is claimed.
- [ ] D1..D10 receive decisions before the dependent implementation work.
- [ ] Implementation proceeds through small independently reviewable PRs, not by merging an entire code rewrite as one branch.

**Out of scope of this draft:** runtime file changes, production upgrade, agent dispatch, new account connections, provider secrets, EP registry writes, deployment or budget increases.
