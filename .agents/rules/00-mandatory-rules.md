# Mandatory AIWorks Agent Governance

@[constitution](../../docs/PRODUCT_CONSTITUTION.md)

## Pre-Flight Requirements (BEFORE ANY TOOL CALL OR CODE EDIT)

1. **Synchronize with `origin/main`**:
   - Run `git status` to verify working tree status.
   - If behind `origin/main`, you MUST pull or fast-forward (`git pull --ff-only`) before making changes.
   - Never develop or test against a stale runtime head.

2. **Read Project Documentation**:
   - Read `AGENTS.md`, `docs/PRODUCT_CONSTITUTION.md`, and `docs/SUPERVISOR.md`.
   - Work within authorized scope. Do not mutate governance directories or provider resources.

3. **Owner-Words Policy**:
   - Zero internal machine words outside `<details>` disclosures on any owner-facing screen or copy:
     - FORBIDDEN: `supervisor`, `coordinator`, `campaign`, `controller`, `executor`, `the task`, `agent` (except "Cursor Agent").
     - APPROVED: `AI worker`, `Planner / Assistant`, `Independent Checker`, `step`, `delivery engine`.

4. **Validation and Evidence**:
   - Never bypass branch protection, squashes, or force-push.
   - Run `npm run check` on the clean head commit before marking any task as complete.
