# Agent rules

AIWorks is a local AI delivery supervisor, coordinator, dashboard and worker-context runtime. Read [README.md](README.md), [the product constitution](docs/PRODUCT_CONSTITUTION.md) and [the supervisor runbook](docs/SUPERVISOR.md).

## Public source and private installation data

This repository contains reusable code, documentation and synthetic test fixtures only. Campaign declarations are private operator data. Keep all installation-specific data under ignored `.local/`: campaigns, project registries, governance, approvals, settings and evidence. Legacy ignored paths are compatibility locations only; new installation data goes in `.local/`. Never commit campaigns, authorization records, actual project registries, machine configuration, run artifacts, logs, credentials or deployment evidence. Documentation and tests must use fictional repositories and example paths. Do not name an operator's other projects or hosts.

Project governance comes from a separately configured read-only governance directory. Read its applicable rules for an assigned task; never copy its private contents into this repository.

## Authorized work

Development builds and tests for AIWorks and every project it manages run locally. Do not create, enable, dispatch or rerun GitHub Actions, including free or self-hosted runners. Do not use paid GitHub features or incur GitHub charges: no Codespaces, paid runners, billable Packages or Git LFS storage/bandwidth, paid marketplace services, paid add-ons or GitHub plan upgrades. Do not upload packages or LFS objects, provision GitHub resources or change billing. AI usage is allowed in any billing mode, including subscriptions and metered APIs; this rule imposes no new AI spending restriction. Existing campaign authority, budgets and security controls still apply. Keep Actions disabled at the repository level before GitHub publication; commit skip markers do not cover every workflow event. Keep required checks and branch protection intact.

Agents may change AIWorks code, scripts, schemas, tests and documentation. An operator may explicitly register a local campaign under existing owner authority. The supervisor may also register the next wave itself, but only under an owner-approved program record and only when every slice fits it exactly ([AW-011](docs/DECISIONS.md#aw-011---the-next-wave-starts-by-itself-under-an-owner-approved-program-record)); this is built switched off until PROG5. Registration never requires publishing its declaration. Runtime code must be merged before it starts new work; campaign scope, authorization version and independent verification remain binding.

The supervisor may create isolated worktrees and campaign branches only in a registered campaign's target repository. Where that repository publishes through GitHub it may open pull requests and post issue comments there; for AIWorks's own repository with local main trusted it records them in the local work list instead (AW-001). It merges only under the merge gate, when the owner opts in for that repository (AW-001, [the runbook](docs/SUPERVISOR.md#merge-gate)); it never squashes, rebases, force-pushes or bypasses branch protection. It may remove the worktrees of finished tasks and delete the local task branches the trusted main contains; it never deletes a remote branch, a worktree with changes or run evidence. It deploys or releases only under an AW-010 grant, never into its own live runtime, and never changes provider resources.

Do not change another project from work here, mutate the governance directory, restart production, create provider resources, read secret files, expose secret values, widen execution grants or weaken security controls without explicit operator authorization.

## Owner intervention

Ask only for owner-reserved decisions, destructive actions that lack authorization, or access only the operator can grant after allowed alternatives fail. Prove the concrete failing step and continue independent authorized work. Routine implementation choices, file sequencing and provider waits are not owner stops. Never introduce a new owner-dependent blocking gate without authorization.

## Review and runtime maintenance

Changes to `src/supervisor` need independent approval of the exact head commit before merge. A green test run alone is insufficient. Preparing a branch does not upgrade the running system.

For an upgrade or relocation, record unfinished campaign status, pause admissions, drain open operations, stop the services and verify they exited. Preserve registered declarations, task outcomes, authority and scope digests, budgets, retry timers and historical evidence. Deploy the exact reviewed revision of the trusted main: `git rev-parse origin/main`, or `node src/supervisor/cli.mjs trusted-main` when AIWorks trusts local main (AW-005), then resume existing campaigns with their identical private declarations. Compare status afterward. Coordinate with any other session maintaining the runtime.

Never name a target branch `campaign/<campaignId>`: task branches use `campaign/<campaignId>/<taskId>`, which cannot coexist with that prefix branch.

## Evidence and secrets

Distinguish observed code, verified runtime behaviour, planned design and unknown state. A merged change is not evidence of a deployment. Keep installation status and private evidence outside the public tree. AIWorks's own findings, owner decisions and review reports live in the local work list once it is on; GitHub issues are then a historical record. Credentials belong in an operator-managed secret store; configuration holds executable paths and repository paths, never secret values.

## Validation

Run `npm install` once, then `npm run check` after changes to code, schemas, fixtures or documentation. The checks use synthetic campaigns and governance fixtures, never private operator campaigns. While you work, `npm run test:affected` runs only the test files your changes can reach; it is not the gate. Review the staged file list and run the public-scope check before committing.

Write a test only when it protects product-critical behaviour: something that, if it broke, would lose or corrupt the owner's data, leak a secret or private data, run, publish, merge or deploy work that was not authorized and verified, repeat an irreversible action after a crash, run paid worker runs without bound, let a worker escape its containment, or stop the core loop (declare, implement, verify the exact head, publish, merge). One test per such behaviour, at the lowest layer that shows it. Do not write tests for wording, layout, display, reporting, documentation, tooling or convenience behaviour, and never pin prose, source text or line numbers. A feature that is switched off gets its critical tests in the change that switches it on; earlier tests are in git history. A test that does not meet this rule may be removed.
