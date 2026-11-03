# Git Maintenance & Merge Orchestrator

Status: implementation specification, with staged delivery below. This is part of AIWorks, not a separate product. This plan does not start workers, enable cleanup or grant merge authority.

## Goal
Safely inventory explicitly selected Git repositories, coordinate AIWorks agent worktrees, finish authorized work through the existing verification and merge gates, and clean up only verified disposable worktrees.

## Existing implementation and private baseline

Machine inventories, project names, schedules, paths and audit reports belong under ignored `.local/`. Public examples and tests use fictional repositories. Classification is advisory, never deletion authorization.

| Requirement | Existing code to reuse | Remaining integration |
| --- | --- | --- |
| Worktree inventory | `src/supervisor/adapters/git.mjs`: `worktreeList`, `worktreeChanges`, ancestry checks | Read-only inventory and ownership report |
| Ownership and activity | `store.mjs`: campaigns, operations, leases and coordinator runs | Correlate each worktree with recorded ownership; unknown stays unknown |
| Serialized merge and recovery | `merge.mjs`, `merge-batch.mjs`, `self-hosting.mjs`, store fencing | Reuse the existing merge gate; do not create a second merge queue |
| Conflict repair | Integration repair, merge refresh and exact-head verification | Reuse the authorized repair path and independent verifier |
| Cleanup | `cleanup.mjs`: scoped opt-in, evidence preservation and removal journal | Read-only cleanup plan and stricter eligibility before activation |

An unregistered branch is inventory, not a merge assignment. Maintenance must not mark its own output verified or write directly to the trusted-main ledger.

## Deliverables

### A. Git maintenance inventory
- Discover top-level repositories under configurable roots, resolve actual git common-dir, worktree porcelain records, branch upstream, merge-base, dirty/untracked state, and linked worktree paths.
- Deduplicate by the resolved common directory. Resolve and constrain paths before inspection; report inaccessible or out-of-root worktrees without following them. Inventory does not fetch or refresh indexes. Ahead/behind describes locally observed refs, not fresh remote state.
- Detect stale metadata, locked worktrees, active processes, AIWorks job leases, detached HEAD, ahead/behind, unpushed commits, and untracked files.
- Do not treat directory modification time or merged branch alone as proof of inactivity.
- A missing/unreadable ownership store or inconclusive process check is unknown activity, never proof of inactivity. Include ignored evidence as well as tracked and untracked changes.
- Machine-readable JSON report with classification, reason, evidence, and suggested action. Redact secrets and avoid logging file contents.
- Audit mode default; config-driven allowlist for mutations. A scheduler runs audit only, and is installed only on explicit request.

### B. Merge orchestration
- Per-repository serialized queue; idempotent job IDs; filesystem lock + durable lease; crash recovery and retry policies.
- AIWorks agent task -> branch/worktree ownership -> completion signal -> merge candidate.
- Check origin, PR review/required checks, clean status, commits, remote state and branch protection before integration.
- Run merges in disposable isolated worktrees, never directly in an agent's active tree.
- Preserve the existing merge-commit policy (AW-001): no squash or rebase. A separately authorized safe checkout sync may fast-forward a clean, inactive checkout with an upstream; dirty, divergent, unknown-activity and missing-upstream cases remain unchanged. Simulate integration in isolation and capture conflict artifacts.
- Preserve source refs and pre-merge SHAs; never force-push, hard-reset, delete unpushed commits, or silently change main.
- Promote only after configured build, lint, tests and policy checks succeed. Use GitHub PR merge APIs when branch protection requires it.
- Never create, enable, dispatch or rerun workflows, invent check results or weaken protection (owner directive of 2 November 2026: GitHub Actions stay prohibited; the former Actions-permissions check before each publication is removed). Respect local trusted-main policy for self-hosted work.

### C. AI conflict resolution (opt-in, later phase)
- Three-way context (base/ours/theirs), minimal relevant diff and repository policy.
- Prefer Git rerere for previously reviewed identical resolutions.
- AI proposes patch in isolated worktree; verify no unresolved conflict markers, no unintended file changes, build and tests.
- Semantic conflicts may exist without textual conflicts; require contract/integration tests.
- Confidence alone never authorizes a merge. Dependency changes, schema migrations, auth/security, binaries and generated files follow existing independent review rules. Decisions and stopped steps follow AW-017; this plan introduces no new owner-dependent gate. Missing destructive authority ends that action with a concrete follow-up.
- Configurable model/provider and data boundaries; no automatic transfer of secrets or sensitive source to external LLM.

### D. Cleanup
- Never delete primary, locked, dirty, running, leased, or unknown-state worktrees.
- Require verified merged commit, no unpushed unique commits, successful job completion, no active agent lease/process, age grace period, and auditable allowlist.
- Recheck eligibility immediately before removal, including the exact worktree head's containment in trusted main. Preserve runtime checkouts, unknown ignored files, run evidence and another session's work. Age is applied only after completion is proved.
- Separate worktree prune metadata from worktree remove; prune dry-run by default.
- Two-phase quarantine (move only when technically safe and supported; otherwise retain) and retention policy. Never use git worktree remove --force by default.
- Deletion is off by default until acceptance tests and explicit config enable it.

### E. Operational UX
- CLI commands: audit, plan, sync --safe, merge --job, cleanup --dry-run, cleanup --apply (guarded).
- JSON reports, per-repository summary, exit codes, alerts for conflicts or blocked jobs.
- Metrics: worktrees active/dirty/stale, merge success, conflict rate, recovered jobs, duration, bytes reclaimed.
- Windows PowerShell support and local smoke tests. GitHub Actions is prohibited.

## Acceptance criteria
1. Explicitly selected repositories and their linked worktrees are inventoried without changing refs, index or worktree bytes. Synthetic fixtures cover primary, linked, detached, locked and inaccessible checkouts; actual machine results stay private.
2. No dirty, locked, active or unmerged worktree can be removed in automated mode; negative tests demonstrate this.
3. Two concurrent jobs targeting one repository are serialized; crash/restart resumes safely without double merge.
4. Fast-forward-only path succeeds and divergent/dirty/no-upstream path skips without data loss.
5. Synthetic conflicting branches: conflict captured, candidate patch validated; failure leaves main and source refs untouched.
6. Build/test failure blocks promotion. Branch protections and PR checks are respected. GitHub Actions stay prohibited, and publication does not depend on reading Actions permissions.
7. Logs are sufficient to reconstruct decisions and include no credentials.
8. Cleanup dry-run and actual cleanup have separate opt-in permissions; no destructive action is enabled by deployment.

## Implementation sequence
- P0: inventory, tests, reliable worktree classification, activity/lease integration and dry-run reports.
- P1: serialized merge queue, isolated worktrees, checks, recovery and safe promotion.
- P2: AI-assisted conflict proposals and semantic validation.
- P3: guarded cleanup, retention, alerts and dashboard.

## Non-goals
- No new standalone repository.
- No unattended merge of arbitrary branches or automatic deletion of existing worktrees based only on this plan.
- No promise that textual merge success guarantees semantic correctness.

## Delivered scope

P0 (merged) added the read-only `maintenance audit` command. P1 (this change) adds to the existing merge gate what it lacked for serialized, checked promotion, and the separately authorized safe checkout sync; it creates no second queue:
- the base a pass fetched is checked, inside the fenced merge request, against the newest merge AIWorks recorded on that base across campaigns, so a second instance never merges onto a base another instance moved after the fetch (acceptance 3; the merge call itself already runs under the store's write lock);
- a refused merge call backs off from the second refusal on, up to an hour, instead of every poll;
- GitHub's `mergeable_state` (branch protection, required checks and reviews, drafts) holds a head back as a wait;
- each requested GitHub merge is checked once for the shape it asked for (`merge-shape`: the requested base and verified head as parents, the verified or gated tree), recorded as information; the next head onto that base is judged by the existing condition 3;
- `maintenance sync --repo <checkout> [--apply]`: fast-forward of one clean, inactive checkout to its locally observed upstream, dry run by default, applied only for a path listed under `maintenance.sync` (acceptance 4).

Left for later stages: durable merge job records with their own IDs (the journal's `<campaign>:<task>:<sha>` key stays the identity), conflict artifacts beyond paths and sibling commits (P2), ownership records for refresh and group worktrees so cleanup can remove them (P3), and the `plan`, `merge --job` and `cleanup` commands.

## P0 command
P0 adds the read-only `maintenance audit` command. It reports local Git state, recorded activity and verification; external process activity remains explicitly unknown. It does not infer cleanup eligibility from the audit or claim that local `main` is the ledger's trusted tip. P1 is delivered in the scope above. P2 and P3 remain planned. No mutation beyond that delivered sync is enabled.

```sh
node src/supervisor/cli.mjs maintenance audit --repo <checkout> --root <allowed-root> --data <private-data-directory>
```

`--repo` selects one repository; `--root` also discovers immediate repositories and bounds linked-worktree inspection. At least one is required. Linked worktrees and common Git directories outside these roots are reported without inspection. The store is opened read-only when present; a missing store leaves ownership unknown. The JSON includes paths and task identifiers and belongs under ignored `.local/`, never in a public commit. Reports omit file contents and remote URLs. Run `npm install` once and `npm run check` locally after changes. Add only critical-behaviour tests permitted by AGENTS.md, with removal tests in the change that enables the apply path.
