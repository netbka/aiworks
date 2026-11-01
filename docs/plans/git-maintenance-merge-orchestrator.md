# Git Maintenance & Merge Orchestrator

Status: implementation specification. Owner: AIWorks. Execution: Local Commander on HomePc and other explicitly selected devices.

## Goal
Safely maintain Git repositories (initial scope D:\git), coordinate AIWorks agent worktrees, merge completed work, validate results, and clean up only verified disposable worktrees. No separate product or repository.

## Existing baseline (HomePc, 2026-11-01)
- D:\git\git-maintenance.ps1: repository audit and opt-in fast-forward sync.
- D:\git\git-manager.ps1: inventory/classification, audit JSON and opt-in fast-forward sync.
- Windows Task Scheduler: Git Maintenance Audit daily 03:30, read-only.
- 28 repositories discovered. bazist: 49 worktrees in latest audit (2 merged/clean review, 44 unmerged or detached review, 2 dirty, 1 locked). Classification is advisory, not deletion authorization.
- Audit report: D:\git\_git-maintenance-reports\manager-20261101-225101.json.

## Deliverables

### A. Git maintenance inventory
- Discover top-level repositories under configurable roots, resolve actual git common-dir, worktree porcelain records, branch upstream, merge-base, dirty/untracked state, and linked worktree paths.
- Detect stale metadata, locked worktrees, active processes, AIWorks job leases, detached HEAD, ahead/behind, unpushed commits, and untracked files.
- Do not treat directory modification time or merged branch alone as proof of inactivity.
- Machine-readable JSON report with classification, reason, evidence, and suggested action. Redact secrets and avoid logging file contents.
- Audit mode default; config-driven allowlist for mutations. Windows Task Scheduler runs audit only initially.

### B. Merge orchestration
- Per-repository serialized queue; idempotent job IDs; filesystem lock + durable lease; crash recovery and retry policies.
- AIWorks agent task -> branch/worktree ownership -> completion signal -> merge candidate.
- Check origin, PR review/required checks, clean status, commits, remote state and branch protection before integration.
- Run merges in disposable isolated worktrees, never directly in an agent's active tree.
- Fast-forward where possible. For divergent branches, simulate merge and capture conflict artifacts.
- Preserve source refs and pre-merge SHAs; never force-push, hard-reset, delete unpushed commits, or silently change main.
- Promote only after configured build, lint, tests and policy checks succeed. Use GitHub PR merge APIs when branch protection requires it.

### C. AI conflict resolution (opt-in, later phase)
- Three-way context (base/ours/theirs), minimal relevant diff and repository policy.
- Prefer Git rerere for previously reviewed identical resolutions.
- AI proposes patch in isolated worktree; verify no unresolved conflict markers, no unintended file changes, build and tests.
- Semantic conflicts may exist without textual conflicts; require contract/integration tests.
- Confidence alone never authorizes a merge; low confidence, dependency changes, schema migrations, auth/security, binaries and generated files require human review.
- Configurable model/provider and data boundaries; no automatic transfer of secrets or sensitive source to external LLM.

### D. Cleanup
- Never delete primary, locked, dirty, running, leased, or unknown-state worktrees.
- Require verified merged commit, no unpushed unique commits, successful job completion, no active agent lease/process, age grace period, and auditable allowlist.
- Separate worktree prune metadata from worktree remove; prune dry-run by default.
- Two-phase quarantine (move only when technically safe and supported; otherwise retain) and retention policy. Never use git worktree remove --force by default.
- Deletion is off by default until acceptance tests and explicit config enable it.

### E. Operational UX
- CLI commands: audit, plan, sync --safe, merge --job, cleanup --dry-run, cleanup --apply (guarded).
- JSON reports, per-repository summary, exit codes, alerts for conflicts or blocked jobs.
- Metrics: worktrees active/dirty/stale, merge success, conflict rate, recovered jobs, duration, bytes reclaimed.
- Windows PowerShell support and CI smoke tests.

## Acceptance criteria
1. All 28 HomePc repositories are inventoried without modification; bazist linked worktrees are enumerated with evidence.
2. No dirty, locked, active or unmerged worktree can be removed in automated mode; negative tests demonstrate this.
3. Two concurrent jobs targeting one repository are serialized; crash/restart resumes safely without double merge.
4. Fast-forward-only path succeeds and divergent/dirty/no-upstream path skips without data loss.
5. Synthetic conflicting branches: conflict captured, candidate patch validated; failure leaves main and source refs untouched.
6. Build/test failure blocks promotion. Branch protections and PR checks are respected.
7. Logs are sufficient to reconstruct decisions and include no credentials.
8. Cleanup dry-run and actual cleanup have separate opt-in permissions; no destructive action is enabled by deployment.

## Implementation sequence
- P0: inventory, tests, reliable worktree classification, activity/lease integration and dry-run reports.
- P1: serialized merge queue, isolated worktrees, checks, recovery and safe promotion.
- P2: AI-assisted conflict proposals and semantic validation.
- P3: guarded cleanup, retention, alerts and dashboard.

## Non-goals
- No new standalone repository.
- No unattended merge of arbitrary branches or automatic deletion of existing bazist worktrees.
- No promise that textual merge success guarantees semantic correctness.

## Current PR scope
Specification only. Implementation and automatic cleanup are not claimed complete. Existing scripts on HomePc are not yet migrated into AIWorks source control.
