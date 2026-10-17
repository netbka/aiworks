# Agent rules

AIWorks is a local AI delivery supervisor, coordinator, dashboard and worker-context runtime. Read [README.md](README.md), [the product constitution](docs/PRODUCT_CONSTITUTION.md) and [the supervisor runbook](docs/SUPERVISOR.md).

## Public source and private installation data

This repository contains reusable code, documentation and synthetic test fixtures only. Campaign declarations are private operator data. Keep them in ignored `campaigns/`, `.local/campaigns/`, or a directory outside this checkout. Never commit campaigns, authorization records, actual project registries, machine configuration, run artifacts, logs, credentials or deployment evidence. Documentation and tests must use fictional repositories and example paths. Do not name an operator's other projects or hosts.

Project governance comes from a separately configured read-only governance directory. Read its applicable rules for an assigned task; never copy its private contents into this repository.

## Authorized work

Agents may change AIWorks code, scripts, schemas, tests and documentation. An operator may explicitly register a local campaign under existing owner authority. Registration never requires publishing its declaration. Runtime code must be merged before it starts new work; campaign scope, authorization version and independent verification remain binding.

The supervisor may create isolated worktrees, campaign branches, pull requests and issue comments only in a registered campaign's target repository. It merges only under the merge gate, when the owner opts in for that repository (AW-001, [the runbook](docs/SUPERVISOR.md#merge-gate)); it never squashes, rebases, force-pushes, bypasses branch protection or deletes a branch. It never deploys, releases or changes provider resources.

Do not change another project from work here, mutate the governance directory, restart production, create provider resources, read secret files, expose secret values, widen execution grants or weaken security controls without explicit operator authorization.

## Owner intervention

Ask only for owner-reserved decisions, destructive actions that lack authorization, or access only the operator can grant after allowed alternatives fail. Prove the concrete failing step and continue independent authorized work. Routine implementation choices, file sequencing and provider waits are not owner stops. Never introduce a new owner-dependent blocking gate without authorization.

## Review and runtime maintenance

Changes to `src/supervisor` need independent approval of the exact head commit before merge. A green test run alone is insufficient. Preparing a branch does not upgrade the running system.

For an upgrade or relocation, record unfinished campaign status, pause admissions, drain open operations, stop the services and verify they exited. Preserve registered declarations, task outcomes, authority and scope digests, budgets, retry timers and historical evidence. Deploy the exact reviewed revision from `git rev-parse origin/main`, then resume existing campaigns with their identical private declarations. Compare status afterward. Coordinate with any other session maintaining the runtime.

Never name a target branch `campaign/<campaignId>`: task branches use `campaign/<campaignId>/<taskId>`, which cannot coexist with that prefix branch.

## Evidence and secrets

Distinguish observed code, verified runtime behaviour, planned design and unknown state. A merged change is not evidence of a deployment. Keep installation status and private evidence outside the public tree. Credentials belong in an operator-managed secret store; configuration holds executable paths and repository paths, never secret values.

## Validation

Run `npm install` once, then `npm run check` after changes to code, schemas, fixtures or documentation. The checks use synthetic campaigns and governance fixtures, never private operator campaigns. While you work, `npm run test:affected` runs only the test files your changes can reach; it is not the gate.

Write a test only when it protects product-critical behaviour: something that, if it broke, would lose or corrupt the owner's data, leak a secret or private data, run, publish, merge or deploy work that was not authorized and verified, repeat an irreversible action after a crash, let a worker escape its containment, or stop the core loop (declare, implement, verify the exact head, publish, merge). One test per such behaviour, at the lowest layer that shows it. Do not write tests for wording, layout, display, reporting, documentation, tooling or convenience behaviour, and never pin prose, source text or line numbers. A feature that is switched off gets its critical tests in the change that switches it on; earlier tests are in git history. A test that does not meet this rule may be removed. Review the staged file list and run the public-scope check before committing.
